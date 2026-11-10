#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
arena.py - deterministic bookkeeping for the idea-arena skill.

Agents (subagents, or Claude playing each role in turn) write JSON files.
This script is the only thing that writes derived files: it validates agent output,
anonymizes ideas, aggregates scores, builds the debate agenda, feedback packets,
and the final ranking/report. Standard library only, Python 3.8+.

  arena.py presets
  arena.py init   --topic "..." [--constraint "..."]... [--preset product] [--depth standard]
                  [--language Korean] [--isolation subagents|single-context] [--ideas 2]
                  [--generators a,b] [--judges x,y] [--root DIR | --dir DIR] [--run-id ID]
  arena.py status --dir RUN_DIR
  arena.py brief  --dir RUN_DIR --agent AGENT_ID
  arena.py check  --dir RUN_DIR
  arena.py next   --dir RUN_DIR
  arena.py report --dir RUN_DIR

Exit codes: 0 ok / waiting for agents | 1 blocked (fix the listed files)
            2 usage or config error   | 3 integrity conflict (do not delete files; ask the user)
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

ARENA_VERSION = "1.0"
SKILL_DIR = Path(__file__).resolve().parent.parent
PRESETS_FILE = SKILL_DIR / "assets" / "presets.json"

BASES = ["NEW_ARGUMENT", "PEER_PERSUASION", "ERROR_CORRECTION"]
STANCES = ["MAINTAIN", "REVISE"]
CORE_TEXT = ["title", "oneLiner", "problem", "audience", "approach", "differentiation"]
CORE_LIST = ["firstSteps", "assumptions"]
AGENT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
CRITERION_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,39}$")

DEFAULT_HINTS = {
    "title": "Name of the idea",
    "oneLiner": "The idea in one sentence",
    "problem": "The problem or goal it addresses",
    "audience": "Who it is for",
    "approach": "How it works",
    "differentiation": "Difference from existing alternatives",
    "firstSteps": "First small step or experiment",
}

AGENT_PHASES = {"GENERATING": "generators", "SCORING": "judges", "DEBATING": "judges",
                "REVISING": "generators", "RESCORING": "judges"}


# --------------------------------------------------------------------------- errors

class ArenaError(Exception):
    code = 2


class Blocked(ArenaError):
    code = 1

    def __init__(self, errors):
        super().__init__("blocked")
        self.errors = errors


class Integrity(ArenaError):
    code = 3


# --------------------------------------------------------------------------- io

def setup_stdout():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:
            pass


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _replace(tmp, path):
    # OneDrive / antivirus can briefly lock files on Windows.
    for attempt in range(8):
        try:
            os.replace(str(tmp), str(path))
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(0.15 * (attempt + 1))


def write_text(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(str(tmp), "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    _replace(tmp, path)


def write_once(paths, path, data):
    """Derived files never change once written. Same content again is a no-op."""
    content = data if isinstance(data, str) else dumps(data)
    path = Path(path)
    if path.exists():
        if path.read_text(encoding="utf-8") == content:
            return
        raise Integrity(
            f"{paths.rel(path)} already exists with different content. Derived files are write-once; "
            "an input it depends on was probably edited after it was consumed. Do not delete anything - "
            "report this to the user and ask how to proceed.")
    write_text(path, content)


def read_json(paths, path):
    path = Path(path)
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        raise Blocked([f"{paths.rel(path)}: invalid JSON (line {e.lineno}, column {e.colno}): {e.msg}"])


def try_read(paths, path, errors):
    try:
        return read_json(paths, path)
    except Blocked as b:
        errors.extend(b.errors)
        return None


def r2(x):
    v = round(float(x), 2)
    return 0.0 if v == 0 else v


def fmt(x):
    return "-" if x is None else f"{x:.1f}"


# --------------------------------------------------------------------------- paths

class Paths:
    def __init__(self, d):
        self.d = Path(d).resolve()
        self.config = self.d / "config.json"
        self.mapping = self.d / "private" / "mapping.json"
        self.agenda = self.d / "debate" / "agenda.json"
        self.resolution = self.d / "debate" / "resolution.json"
        self.ranking = self.d / "final" / "ranking.json"
        self.report = self.d / "final" / "report.md"

    def gen(self, g):
        return self.d / "private" / "generations" / f"{g}.json"

    def blind(self, v, iid):
        return self.d / "blind" / f"v{v}" / f"{iid}.json"

    def eval(self, r, j):
        return self.d / "evaluations" / f"round-{r}" / f"{j}.json"

    def aggregate(self, r):
        return self.d / "evaluations" / f"round-{r}" / "aggregate.json"

    def debate(self, j):
        return self.d / "debate" / f"{j}.json"

    def feedback(self, g):
        return self.d / "private" / "feedback" / f"{g}.json"

    def revision(self, g):
        return self.d / "private" / "revisions" / f"{g}.json"

    def rel(self, p):
        try:
            return Path(p).resolve().relative_to(self.d).as_posix()
        except ValueError:
            return str(p)

    def sources(self, files):
        return {self.rel(f): sha(f) for f in files}


# --------------------------------------------------------------------------- config

def lang_code(language):
    s = (language or "").strip().lower()
    if s.startswith("ko") or "korean" in s or "한국" in s:
        return "ko"
    return "en"


def pick_label(v, lang):
    if isinstance(v, dict):
        return v.get(lang) or v.get("en") or next(iter(v.values()))
    return v


def load_presets():
    return json.loads(PRESETS_FILE.read_text(encoding="utf-8"))


def gen_ids(cfg):
    return [g["id"] for g in cfg["generators"]]


def judge_ids(cfg):
    return [j["id"] for j in cfg["judges"]]


def crit_ids(cfg):
    return [c["id"] for c in cfg["criteria"]]


def ideas_for(cfg, gid):
    g = next(x for x in cfg["generators"] if x["id"] == gid)
    return g.get("ideas", cfg["ideasPerGenerator"])


def agent(cfg, aid):
    for a in cfg["generators"] + cfg["judges"]:
        if a["id"] == aid:
            return a
    return None


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_config(cfg):
    e = []

    def text(obj, k, where):
        v = obj.get(k) if isinstance(obj, dict) else None
        if not isinstance(v, str) or not v.strip():
            e.append(f"config.json: {where}{k} must be a non-empty string")

    if not isinstance(cfg, dict):
        return ["config.json: must be a JSON object"]
    for k in ["runId", "topic", "language"]:
        text(cfg, k, "")
    if not isinstance(cfg.get("constraints"), list) or not all(isinstance(x, str) for x in cfg.get("constraints", [])):
        e.append("config.json: constraints must be a list of strings")
    if cfg.get("depth") not in ("quick", "standard"):
        e.append('config.json: depth must be "quick" or "standard"')
    if cfg.get("isolation") not in ("subagents", "single-context"):
        e.append('config.json: isolation must be "subagents" or "single-context"')
    ipg = cfg.get("ideasPerGenerator")
    if not is_int(ipg) or not 1 <= ipg <= 10:
        e.append("config.json: ideasPerGenerator must be an integer 1-10")

    seen = set()
    for group, minimum in (("generators", 1), ("judges", 2)):
        items = cfg.get(group)
        if not isinstance(items, list) or len(items) < minimum:
            e.append(f"config.json: {group} must be a list with at least {minimum} entr{'y' if minimum == 1 else 'ies'}")
            continue
        for i, a in enumerate(items):
            w = f"{group}[{i}]."
            if not isinstance(a, dict):
                e.append(f"config.json: {group}[{i}] must be an object")
                continue
            aid = a.get("id")
            if not isinstance(aid, str) or not AGENT_ID_RE.match(aid):
                e.append(f"config.json: {w}id must match {AGENT_ID_RE.pattern} (lowercase, digits, hyphens)")
            elif aid in seen:
                e.append(f"config.json: duplicate agent id '{aid}' (ids must be unique across generators and judges)")
            else:
                seen.add(aid)
            text(a, "name", w)
            text(a, "lens", w)
            if group == "generators" and "ideas" in a and (not is_int(a["ideas"]) or not 1 <= a["ideas"] <= 10):
                e.append(f"config.json: {w}ideas must be an integer 1-10")
            extra = set(a) - ({"id", "name", "lens", "ideas"} if group == "generators" else {"id", "name", "lens"})
            if extra:
                e.append(f"config.json: {w} unknown field(s) {sorted(extra)}")

    crits = cfg.get("criteria")
    if not isinstance(crits, list) or not crits:
        e.append("config.json: criteria must be a non-empty list")
    else:
        cseen, total = set(), 0.0
        for i, c in enumerate(crits):
            w = f"criteria[{i}]."
            if not isinstance(c, dict):
                e.append(f"config.json: criteria[{i}] must be an object")
                continue
            cid = c.get("id")
            if not isinstance(cid, str) or not CRITERION_ID_RE.match(cid):
                e.append(f"config.json: {w}id must match {CRITERION_ID_RE.pattern}")
            elif cid in cseen:
                e.append(f"config.json: duplicate criterion id '{cid}'")
            else:
                cseen.add(cid)
            text(c, "label", w)
            text(c, "description", w)
            if not is_num(c.get("weight")) or c.get("weight") < 0:
                e.append(f"config.json: {w}weight must be a number >= 0")
            else:
                total += c["weight"]
        if abs(total - 100) > 1e-6:
            e.append(f"config.json: criteria weights must sum to 100 (currently {r2(total)})")

    s = cfg.get("scoring")
    if not isinstance(s, dict):
        e.append("config.json: scoring must be an object")
    else:
        if not is_int(s.get("maxScore")) or not 1 <= s["maxScore"] <= 10:
            e.append("config.json: scoring.maxScore must be an integer 1-10")
        if not is_num(s.get("totalGapThreshold")) or s["totalGapThreshold"] < 0:
            e.append("config.json: scoring.totalGapThreshold must be a number >= 0")
        if not is_int(s.get("criterionGapThreshold")) or s["criterionGapThreshold"] < 1:
            e.append("config.json: scoring.criterionGapThreshold must be an integer >= 1")
        if not is_int(s.get("topN")) or s["topN"] < 1:
            e.append("config.json: scoring.topN must be an integer >= 1")
    if "fieldHints" in cfg and not isinstance(cfg["fieldHints"], dict):
        e.append("config.json: fieldHints must be an object")
    return e


def load(dirpath):
    paths = Paths(dirpath)
    if not paths.config.exists():
        raise ArenaError(f"no config.json in {paths.d} - run `arena.py init` first (or check --dir)")
    cfg = read_json(paths, paths.config)
    errs = validate_config(cfg)
    if errs:
        raise ArenaError("invalid config.json:\n  - " + "\n  - ".join(errs))
    return cfg, paths


# --------------------------------------------------------------------------- validation

class Checker:
    def __init__(self, where):
        self.where = where
        self.errors = []

    def add(self, path, msg):
        self.errors.append(f"{self.where}: {path}: {msg}")

    def obj(self, v, path):
        if not isinstance(v, dict):
            self.add(path, "must be a JSON object")
            return False
        return True

    def keys(self, o, allowed, path):
        extra = [k for k in o if k not in allowed]
        if extra:
            self.add(path, f"unknown field(s) {extra}; allowed: {list(allowed)}")

    def text(self, o, k, path, required=True):
        v = o.get(k)
        if v is None:
            if required:
                self.add(f"{path}.{k}", "required (non-empty string)")
            return None
        if not isinstance(v, str) or not v.strip():
            self.add(f"{path}.{k}", "must be a non-empty string")
            return None
        return v

    def texts(self, o, k, path, min_len=0, required=False):
        v = o.get(k)
        if v is None:
            if required or min_len > 0:
                self.add(f"{path}.{k}", f"required (list of at least {max(min_len, 1)} non-empty string(s))")
            return []
        if not isinstance(v, list) or not all(isinstance(x, str) and x.strip() for x in v):
            self.add(f"{path}.{k}", "must be a list of non-empty strings")
            return []
        if len(v) < min_len:
            self.add(f"{path}.{k}", f"needs at least {min_len} item(s)")
        return v

    def integer(self, v, path, lo, hi):
        if not is_int(v) or not lo <= v <= hi:
            self.add(path, f"must be an integer {lo}-{hi}")
            return False
        return True


def check_idea(c, idea, path, extra=(), with_plan=False):
    if not c.obj(idea, path):
        return
    allowed = CORE_TEXT + CORE_LIST + ["details"] + list(extra) + (["plan"] if with_plan else [])
    c.keys(idea, allowed, path)
    for k in CORE_TEXT:
        c.text(idea, k, path)
    for k in CORE_LIST:
        c.texts(idea, k, path, min_len=1)
    if "authorNotes" in extra and "authorNotes" in idea and not isinstance(idea["authorNotes"], str):
        c.add(f"{path}.authorNotes", "must be a string")
    if "details" in idea:
        d = idea["details"]
        ok = isinstance(d, dict) and all(
            isinstance(v, str) or (isinstance(v, list) and all(isinstance(x, str) for x in v)) for v in d.values())
        if not ok:
            c.add(f"{path}.details", "must be an object whose values are strings or lists of strings")
    if with_plan:
        plan = idea.get("plan")
        if not isinstance(plan, list) or not plan:
            c.add(f"{path}.plan", "required (non-empty list of {stage, goal, deliverables})")
        else:
            for i, st in enumerate(plan):
                p = f"{path}.plan[{i}]"
                if c.obj(st, p):
                    c.keys(st, ["stage", "goal", "deliverables"], p)
                    c.text(st, "stage", p)
                    c.text(st, "goal", p)
                    c.texts(st, "deliverables", p, min_len=1)


def validate_generation(cfg, paths, g):
    f = paths.gen(g)
    errors = []
    data = try_read(paths, f, errors)
    if data is None:
        return None, errors
    c = Checker(paths.rel(f))
    if not c.obj(data, "$"):
        return None, c.errors
    c.keys(data, ["generatorId", "ideas"], "$")
    if data.get("generatorId") != g:
        c.add("$.generatorId", f'must be "{g}"')
    ideas = data.get("ideas")
    n = ideas_for(cfg, g)
    if not isinstance(ideas, list):
        c.add("$.ideas", "must be a list")
    else:
        if len(ideas) != n:
            c.add("$.ideas", f"must contain exactly {n} idea(s), found {len(ideas)}")
        for i, idea in enumerate(ideas):
            check_idea(c, idea, f"$.ideas[{i}]", extra=["authorNotes"])
    return data, c.errors


def validate_evaluation(cfg, paths, j, r, ids):
    f = paths.eval(r, j)
    errors = []
    data = try_read(paths, f, errors)
    if data is None:
        return None, errors
    c = Checker(paths.rel(f))
    if not c.obj(data, "$"):
        return None, c.errors
    c.keys(data, ["judgeId", "round", "evaluations"], "$")
    if data.get("judgeId") != j:
        c.add("$.judgeId", f'must be "{j}"')
    if data.get("round") != r:
        c.add("$.round", f"must be {r}")
    evs = data.get("evaluations")
    out = {}
    mx = cfg["scoring"]["maxScore"]
    crits = crit_ids(cfg)
    if not isinstance(evs, list):
        c.add("$.evaluations", "must be a list")
        return None, c.errors
    allowed = ["ideaId", "version", "scores", "strengths", "weaknesses", "risks",
               "criticalIssues", "hypotheses", "summary"] + (["changeFromPrevious"] if r == 2 else [])
    for i, ev in enumerate(evs):
        p = f"$.evaluations[{i}]"
        if not c.obj(ev, p):
            continue
        c.keys(ev, allowed, p)
        iid = ev.get("ideaId")
        if iid not in ids:
            c.add(f"{p}.ideaId", f"unknown idea id {iid!r}; expected one of {ids}")
        elif iid in out:
            c.add(f"{p}.ideaId", f"duplicate evaluation for {iid}")
        sc = ev.get("scores")
        if c.obj(sc, f"{p}.scores"):
            missing = [k for k in crits if k not in sc]
            extra = [k for k in sc if k not in crits]
            if missing:
                c.add(f"{p}.scores", f"missing criteria {missing}")
            if extra:
                c.add(f"{p}.scores", f"unknown criteria {extra}; expected exactly {crits}")
            for k in crits:
                if k in sc and c.obj(sc[k], f"{p}.scores.{k}"):
                    c.keys(sc[k], ["score", "rationale"], f"{p}.scores.{k}")
                    c.integer(sc[k].get("score"), f"{p}.scores.{k}.score", 0, mx)
                    c.text(sc[k], "rationale", f"{p}.scores.{k}")
        c.texts(ev, "strengths", p, min_len=1)
        c.texts(ev, "weaknesses", p, min_len=1)
        c.texts(ev, "risks", p, min_len=1)
        c.texts(ev, "criticalIssues", p)
        c.texts(ev, "hypotheses", p)
        c.text(ev, "summary", p)
        if r == 2:
            c.text(ev, "changeFromPrevious", p)
        if isinstance(iid, str) and iid in ids and iid not in out:
            out[iid] = ev
    missing = [i for i in ids if i not in out]
    if missing:
        c.add("$.evaluations", f"missing evaluations for {missing} - every idea must be scored")
    return out, c.errors


def validate_debate(cfg, paths, j, targets, r1_by_id):
    f = paths.debate(j)
    errors = []
    data = try_read(paths, f, errors)
    if data is None:
        return None, errors
    c = Checker(paths.rel(f))
    if not c.obj(data, "$"):
        return None, c.errors
    c.keys(data, ["judgeId", "round", "entries"], "$")
    if data.get("judgeId") != j:
        c.add("$.judgeId", f'must be "{j}"')
    entries = data.get("entries")
    out = {}
    mx = cfg["scoring"]["maxScore"]
    crits = crit_ids(cfg)
    if not isinstance(entries, list):
        c.add("$.entries", "must be a list")
        return None, c.errors
    for i, en in enumerate(entries):
        p = f"$.entries[{i}]"
        if not c.obj(en, p):
            continue
        c.keys(en, ["ideaId", "position", "rebuttal", "concessions", "scoreChanges", "stance"], p)
        iid = en.get("ideaId")
        if iid not in targets:
            c.add(f"{p}.ideaId", f"{iid!r} is not on the agenda; debate only {targets}")
        elif iid in out:
            c.add(f"{p}.ideaId", f"duplicate entry for {iid}")
        c.text(en, "position", p)
        c.text(en, "rebuttal", p)
        c.texts(en, "concessions", p)
        stance = en.get("stance")
        if stance not in STANCES:
            c.add(f"{p}.stance", f"must be one of {STANCES}")
        changes = en.get("scoreChanges", [])
        if not isinstance(changes, list):
            c.add(f"{p}.scoreChanges", "must be a list")
            changes = []
        used = set()
        for k, ch in enumerate(changes):
            q = f"{p}.scoreChanges[{k}]"
            if not c.obj(ch, q):
                continue
            c.keys(ch, ["criterion", "from", "to", "basis", "rationale"], q)
            crit = ch.get("criterion")
            if crit not in crits:
                c.add(f"{q}.criterion", f"must be one of {crits}")
            elif crit in used:
                c.add(f"{q}.criterion", f"{crit} changed twice in one entry")
            else:
                used.add(crit)
                if iid in r1_by_id:
                    orig = r1_by_id[iid]["scores"][crit]["score"]
                    if ch.get("from") != orig:
                        c.add(f"{q}.from", f"must equal your round-1 score for {crit} ({orig})")
            if c.integer(ch.get("to"), f"{q}.to", 0, mx) and ch.get("to") == ch.get("from"):
                c.add(f"{q}.to", "equals from - remove the change or pick a different score")
            if ch.get("basis") not in BASES:
                c.add(f"{q}.basis", f"must be one of {BASES}")
            c.text(ch, "rationale", q)
        if stance == "REVISE" and not changes:
            c.add(f"{p}.stance", "REVISE requires at least one scoreChange (use MAINTAIN otherwise)")
        if stance == "MAINTAIN" and changes:
            c.add(f"{p}.stance", "scoreChanges present - stance must be REVISE")
        if isinstance(iid, str) and iid in targets and iid not in out:
            out[iid] = en
    missing = [t for t in targets if t not in out]
    if missing:
        c.add("$.entries", f"missing entries for agenda items {missing}")
    return out, c.errors


def validate_revision(cfg, paths, g, expected):
    f = paths.revision(g)
    errors = []
    data = try_read(paths, f, errors)
    if data is None:
        return None, errors
    c = Checker(paths.rel(f))
    if not c.obj(data, "$"):
        return None, c.errors
    c.keys(data, ["generatorId", "revisions"], "$")
    if data.get("generatorId") != g:
        c.add("$.generatorId", f'must be "{g}"')
    revs = data.get("revisions")
    out = {}
    if not isinstance(revs, list):
        c.add("$.revisions", "must be a list")
        return None, c.errors
    for i, rv in enumerate(revs):
        p = f"$.revisions[{i}]"
        if not c.obj(rv, p):
            continue
        c.keys(rv, ["ideaId", "idea", "changelog", "rejectedFeedback"], p)
        iid = rv.get("ideaId")
        if iid not in expected:
            c.add(f"{p}.ideaId", f"{iid!r} is not one of your ideas {expected}")
        elif iid in out:
            c.add(f"{p}.ideaId", f"duplicate revision for {iid}")
        check_idea(c, rv.get("idea"), f"{p}.idea", with_plan=True)
        cl = rv.get("changelog")
        if not isinstance(cl, list) or not cl:
            c.add(f"{p}.changelog", "required (non-empty list of {change, addresses})")
        else:
            for k, x in enumerate(cl):
                q = f"{p}.changelog[{k}]"
                if c.obj(x, q):
                    c.keys(x, ["change", "addresses"], q)
                    c.text(x, "change", q)
                    c.text(x, "addresses", q)
        rj = rv.get("rejectedFeedback", [])
        if not isinstance(rj, list):
            c.add(f"{p}.rejectedFeedback", "must be a list")
        else:
            for k, x in enumerate(rj):
                q = f"{p}.rejectedFeedback[{k}]"
                if c.obj(x, q):
                    c.keys(x, ["feedback", "reason"], q)
                    c.text(x, "feedback", q)
                    c.text(x, "reason", q)
        if isinstance(iid, str) and iid in expected and iid not in out:
            out[iid] = rv
    missing = [x for x in expected if x not in out]
    if missing:
        c.add("$.revisions", f"missing revisions for {missing} - revise every one of your ideas")
    return out, c.errors


# --------------------------------------------------------------------------- scoring

def judge_total(cfg, scores):
    mx = cfg["scoring"]["maxScore"]
    return r2(sum(c["weight"] * scores[c["id"]] / mx for c in cfg["criteria"]))


def aggregate_idea(cfg, iid, judges):
    """judges: list of (judgeId, {criterion: score}, [criticalIssues])"""
    s = cfg["scoring"]
    js = [{"judgeId": jid, "scores": dict(sc), "total": judge_total(cfg, sc), "criticalIssues": list(ci)}
          for jid, sc, ci in judges]
    totals = [x["total"] for x in js]
    gaps = {}
    for cid in crit_ids(cfg):
        vals = [x["scores"][cid] for x in js]
        gaps[cid] = max(vals) - min(vals)
    total_gap = r2(max(totals) - min(totals))
    reasons = []
    if total_gap >= s["totalGapThreshold"]:
        reasons.append({"type": "TOTAL_GAP", "gap": total_gap})
    for cid in crit_ids(cfg):
        if gaps[cid] >= s["criterionGapThreshold"]:
            reasons.append({"type": "CRITERION_GAP", "criterion": cid, "gap": gaps[cid]})
    for x in js:
        for issue in x["criticalIssues"]:
            reasons.append({"type": "CRITICAL_ISSUE", "judgeId": x["judgeId"], "issue": issue})
    return {"ideaId": iid, "judges": js, "score": r2(sum(totals) / len(totals)), "totalGap": total_gap,
            "criterionGaps": gaps, "disagreementReasons": reasons}


def build_aggregate(rnd, ideas):
    dis = sorted([i for i in ideas if i["disagreementReasons"]], key=lambda i: (-i["totalGap"], i["ideaId"]))
    mean_gap = r2(sum(i["totalGap"] for i in ideas) / len(ideas)) if ideas else 0.0
    return {"round": rnd, "ideas": ideas, "disagreements": [i["ideaId"] for i in dis], "meanTotalGap": mean_gap}


def aggregate_round(cfg, rnd, ids, evals):
    ideas = []
    for iid in sorted(ids):
        judges = []
        for j in judge_ids(cfg):
            ev = evals[j][iid]
            judges.append((j, {k: ev["scores"][k]["score"] for k in crit_ids(cfg)}, ev.get("criticalIssues", [])))
        ideas.append(aggregate_idea(cfg, iid, judges))
    return build_aggregate(rnd, ideas)


def apply_debate(cfg, agg1, debates):
    changes, stances = [], []
    ideas = []
    for idea in agg1["ideas"]:
        judges = []
        for jx in idea["judges"]:
            scores = dict(jx["scores"])
            en = debates.get(jx["judgeId"], {}).get(idea["ideaId"])
            if en:
                stances.append({"ideaId": idea["ideaId"], "judgeId": jx["judgeId"], "stance": en["stance"]})
                for ch in en.get("scoreChanges", []):
                    scores[ch["criterion"]] = ch["to"]
                    changes.append({"ideaId": idea["ideaId"], "judgeId": jx["judgeId"], "criterion": ch["criterion"],
                                    "from": ch["from"], "to": ch["to"], "basis": ch["basis"],
                                    "rationale": ch["rationale"]})
            judges.append((jx["judgeId"], scores, jx["criticalIssues"]))
        ideas.append(aggregate_idea(cfg, idea["ideaId"], judges))
    post = build_aggregate(1, ideas)
    counts = {b: 0 for b in BASES}
    for ch in changes:
        counts[ch["basis"]] += 1
    # Still-disputed = was on the agenda and still has a score gap above threshold.
    # (Critical issues do not disappear through debate, so only score gaps count here.)
    unresolved = [i["ideaId"] for i in post["ideas"] if i["ideaId"] in agg1["disagreements"]
                  and any(r["type"] != "CRITICAL_ISSUE" for r in i["disagreementReasons"])]
    return {"postDebate": post, "changes": changes, "stances": stances, "basisCounts": counts,
            "unresolved": unresolved, "meanTotalGapBefore": agg1["meanTotalGap"],
            "meanTotalGapAfter": post["meanTotalGap"]}


def rank_ideas(cfg, ideas):
    top = max(cfg["criteria"], key=lambda c: c["weight"])["id"]

    def key(i):
        m = sum(j["scores"][top] for j in i["judges"]) / len(i["judges"])
        return (-i["score"], i["totalGap"], -m, i["ideaId"])

    return sorted(ideas, key=key)


# --------------------------------------------------------------------------- phase

def mapping_ids(paths):
    m = read_json(paths, paths.mapping)
    return [e["ideaId"] for e in m["entries"]], m


def phase(cfg, paths):
    if any(not paths.gen(g).exists() for g in gen_ids(cfg)):
        return "GENERATING"
    if not paths.mapping.exists():
        return "BLINDING"
    if any(not paths.eval(1, j).exists() for j in judge_ids(cfg)):
        return "SCORING"
    standard = cfg["depth"] == "standard"
    if not paths.aggregate(1).exists() or (standard and not paths.agenda.exists()):
        return "AGGREGATING"
    if standard:
        agenda = read_json(paths, paths.agenda)
        if agenda["targets"] and any(not paths.debate(j).exists() for j in judge_ids(cfg)):
            return "DEBATING"
        if not paths.resolution.exists() or any(not paths.feedback(g).exists() for g in gen_ids(cfg)):
            return "RESOLVING"
        if any(not paths.revision(g).exists() for g in gen_ids(cfg)):
            return "REVISING"
        ids, _ = mapping_ids(paths)
        if any(not paths.blind(2, i).exists() for i in ids):
            return "BLINDING_V2"
        if any(not paths.eval(2, j).exists() for j in judge_ids(cfg)):
            return "RESCORING"
        if not paths.aggregate(2).exists():
            return "AGGREGATING_V2"
    if not paths.report.exists() or not paths.ranking.exists():
        return "FINALIZING"
    return "COMPLETED"


def phase_files(cfg, paths, ph):
    """Files agents must write in an agent phase: list of (path, owner)."""
    if ph == "GENERATING":
        return [(paths.gen(g), g) for g in gen_ids(cfg)]
    if ph == "SCORING":
        return [(paths.eval(1, j), j) for j in judge_ids(cfg)]
    if ph == "DEBATING":
        return [(paths.debate(j), j) for j in judge_ids(cfg)]
    if ph == "REVISING":
        return [(paths.revision(g), g) for g in gen_ids(cfg)]
    if ph == "RESCORING":
        return [(paths.eval(2, j), j) for j in judge_ids(cfg)]
    return []


def integrity_warnings(paths):
    """Derived files record hashes of what they consumed. Report inputs edited afterwards."""
    out = []
    candidates = [paths.mapping, paths.aggregate(1), paths.agenda, paths.resolution, paths.aggregate(2), paths.ranking]
    candidates += sorted((paths.d / "private" / "feedback").glob("*.json")) if (paths.d / "private" / "feedback").is_dir() else []
    for f in candidates:
        if not f.exists():
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        for relp, h in (data.get("_sources") or {}).items():
            src = paths.d / relp
            if not src.exists():
                out.append(f"{relp} was consumed by {paths.rel(f)} but is now missing")
            elif sha(src) != h:
                out.append(f"{relp} changed after {paths.rel(f)} consumed it - the recorded results use the original")
    return sorted(set(out))


# --------------------------------------------------------------------------- automatic steps

def leak_warnings(cfg, iid, obj):
    blob = json.dumps(obj, ensure_ascii=False).lower()
    terms = {"generatorid"}
    for g in cfg["generators"]:
        for who in (g["name"], g["id"]):
            for suffix in (" agent", " generator", " 에이전트", " 생성자"):
                terms.add((who + suffix).lower())
    return [f"{iid}: blind text mentions '{t}' - possible authorship leak" for t in sorted(terms) if t in blob]


def blind_core(idea):
    out = {k: idea[k] for k in CORE_TEXT + CORE_LIST}
    if idea.get("details"):
        out["details"] = idea["details"]
    return out


def step_blind(cfg, paths):
    gens, errors = {}, []
    for g in gen_ids(cfg):
        data, errs = validate_generation(cfg, paths, g)
        errors += errs
        gens[g] = data
    if errors:
        raise Blocked(errors)
    keyed = []
    for g in gen_ids(cfg):
        for idx, _ in enumerate(gens[g]["ideas"]):
            k = hashlib.sha256(f"{cfg['runId']}|{g}|{idx}".encode("utf-8")).hexdigest()
            keyed.append((k, g, idx))
    keyed.sort()
    entries, warns = [], []
    for n, (_, g, idx) in enumerate(keyed, 1):
        iid = f"IDEA-{n:03d}"
        entries.append({"ideaId": iid, "generatorId": g, "index": idx})
        b = dict({"ideaId": iid, "version": 1}, **blind_core(gens[g]["ideas"][idx]))
        warns += leak_warnings(cfg, iid, b)
        write_once(paths, paths.blind(1, iid), b)
    srcs = [paths.config] + [paths.gen(g) for g in gen_ids(cfg)]
    write_once(paths, paths.mapping, {"_sources": paths.sources(srcs), "entries": entries})
    msg = f"BLINDING: {len(entries)} ideas shuffled and anonymized -> blind/v1/"
    return [msg] + [f"warning: {w}" for w in warns]


def load_evals(cfg, paths, rnd, ids):
    evals, errors = {}, []
    for j in judge_ids(cfg):
        data, errs = validate_evaluation(cfg, paths, j, rnd, ids)
        errors += errs
        evals[j] = data
    if errors:
        raise Blocked(errors)
    return evals


def step_aggregate1(cfg, paths):
    ids, _ = mapping_ids(paths)
    evals = load_evals(cfg, paths, 1, ids)
    agg = aggregate_round(cfg, 1, ids, evals)
    agg["_sources"] = paths.sources([paths.eval(1, j) for j in judge_ids(cfg)])
    write_once(paths, paths.aggregate(1), agg)
    msgs = [f"AGGREGATING: round-1 scores aggregated (mean judge gap {agg['meanTotalGap']})"]
    if cfg["depth"] == "standard":
        by_id = {i["ideaId"]: i for i in agg["ideas"]}
        targets = [{"ideaId": t, "totalGap": by_id[t]["totalGap"], "reasons": by_id[t]["disagreementReasons"]}
                   for t in agg["disagreements"]]
        write_once(paths, paths.agenda, {"round": 1, "targets": targets,
                                         "_sources": paths.sources([paths.aggregate(1)])})
        msgs.append(f"debate agenda: {len(targets)} disputed idea(s)" +
                    (f" -> {', '.join(t['ideaId'] for t in targets)}" if targets else " - debate skipped"))
    return msgs


def step_resolve(cfg, paths):
    ids, mapping = mapping_ids(paths)
    agg1 = read_json(paths, paths.aggregate(1))
    agenda = read_json(paths, paths.agenda)
    targets = [t["ideaId"] for t in agenda["targets"]]
    r1 = load_evals(cfg, paths, 1, ids)
    debates, errors = {}, []
    if targets:
        for j in judge_ids(cfg):
            data, errs = validate_debate(cfg, paths, j, targets, r1[j])
            errors += errs
            debates[j] = data
        if errors:
            raise Blocked(errors)
    res = apply_debate(cfg, agg1, debates)
    res["round"] = 1
    res["_sources"] = paths.sources([paths.aggregate(1), paths.agenda] +
                                    ([paths.debate(j) for j in judge_ids(cfg)] if targets else []))

    post = {i["ideaId"]: i for i in res["postDebate"]["ideas"]}
    crit = {c["id"]: c for c in cfg["criteria"]}
    for g in gen_ids(cfg):
        gdata = read_json(paths, paths.gen(g))
        items = []
        for e in [e for e in mapping["entries"] if e["generatorId"] == g]:
            iid = e["ideaId"]
            judges = []
            for jx in post[iid]["judges"]:
                j = jx["judgeId"]
                ev = r1[j][iid]
                en = debates.get(j, {}).get(iid) if debates.get(j) else None
                judges.append({
                    "judgeId": j, "judgeName": agent(cfg, j)["name"], "judgeLens": agent(cfg, j)["lens"],
                    "total": jx["total"],
                    "scores": {k: {"label": crit[k]["label"], "score": jx["scores"][k],
                                   "round1Score": ev["scores"][k]["score"], "rationale": ev["scores"][k]["rationale"]}
                               for k in crit_ids(cfg)},
                    "strengths": ev["strengths"], "weaknesses": ev["weaknesses"], "risks": ev["risks"],
                    "criticalIssues": ev.get("criticalIssues", []), "hypotheses": ev.get("hypotheses", []),
                    "summary": ev["summary"],
                    "debate": None if not en else {k: en.get(k) for k in
                                                   ["position", "rebuttal", "concessions", "stance", "scoreChanges"]},
                })
            items.append({"ideaId": iid, "original": gdata["ideas"][e["index"]],
                          "scoreAfterDebate": post[iid]["score"], "judgeGap": post[iid]["totalGap"],
                          "stillDisputed": iid in res["unresolved"], "judges": judges})
        fb = {"generatorId": g,
              "note": "Feedback on YOUR ideas only. Scores are after the debate; rationales are from round 1.",
              "ideas": items,
              "_sources": paths.sources([paths.gen(g), paths.mapping, paths.agenda] +
                                        [paths.eval(1, j) for j in judge_ids(cfg)] +
                                        ([paths.debate(j) for j in judge_ids(cfg)] if targets else []))}
        write_once(paths, paths.feedback(g), fb)
    write_once(paths, paths.resolution, res)
    bc = res["basisCounts"]
    return [f"RESOLVING: {len(res['changes'])} score change(s) applied "
            f"(new argument {bc['NEW_ARGUMENT']}, peer persuasion {bc['PEER_PERSUASION']}, "
            f"error correction {bc['ERROR_CORRECTION']}); still disputed: {res['unresolved'] or 'none'}; "
            f"mean gap {res['meanTotalGapBefore']} -> {res['meanTotalGapAfter']}",
            "feedback packets written -> private/feedback/"]


def step_blind2(cfg, paths):
    ids, mapping = mapping_ids(paths)
    revs, errors = {}, []
    for g in gen_ids(cfg):
        expected = [e["ideaId"] for e in mapping["entries"] if e["generatorId"] == g]
        data, errs = validate_revision(cfg, paths, g, expected)
        errors += errs
        revs[g] = data
    if errors:
        raise Blocked(errors)
    warns = []
    for e in sorted(mapping["entries"], key=lambda x: x["ideaId"]):
        rv = revs[e["generatorId"]][e["ideaId"]]
        b = dict({"ideaId": e["ideaId"], "version": 2}, **blind_core(rv["idea"]))
        b["plan"] = rv["idea"]["plan"]
        b["changelog"] = rv["changelog"]
        b["rejectedFeedback"] = rv.get("rejectedFeedback", [])
        warns += leak_warnings(cfg, e["ideaId"], b)
        write_once(paths, paths.blind(2, e["ideaId"]), b)
    return [f"BLINDING_V2: {len(ids)} revised ideas anonymized -> blind/v2/"] + [f"warning: {w}" for w in warns]


def step_aggregate2(cfg, paths):
    ids, _ = mapping_ids(paths)
    evals = load_evals(cfg, paths, 2, ids)
    agg = aggregate_round(cfg, 2, ids, evals)
    agg["_sources"] = paths.sources([paths.eval(2, j) for j in judge_ids(cfg)])
    write_once(paths, paths.aggregate(2), agg)
    return [f"AGGREGATING_V2: rescoring aggregated (mean judge gap {agg['meanTotalGap']})"]


# --------------------------------------------------------------------------- report

LABELS = {
    "en": {
        "title": "IDEA ARENA report", "topic": "Topic", "constraints": "Constraints", "none": "(none)",
        "setup": "Setup", "preset": "Preset", "depth": "Depth", "isolation": "Isolation",
        "generators": "Perspectives (generators)", "judges": "Judges", "criteria": "Criteria",
        "top": "Top {n}", "idea": "Idea", "perspective": "Perspective", "final": "Final",
        "r1": "Round 1", "post": "After debate", "gap": "Judge gap",
        "problem": "Problem", "audience": "Audience", "approach": "Approach", "differentiation": "Differentiation",
        "verdicts": "Judges' verdicts", "strengths": "Strengths", "weaknesses": "Weaknesses",
        "risks": "Risks / failure scenarios", "critical": "Critical issues raised",
        "validate": "Hypotheses to validate first", "firstSteps": "First steps", "plan": "Plan",
        "changes": "Changes made after feedback", "rejected": "Feedback rejected by the author (with reasons)",
        "full": "Full ranking", "debate": "Debate",
        "noDebate": "No idea crossed the disagreement thresholds, so no debate was needed.",
        "quickSkip": "Debate, revision and rescoring were skipped (depth: quick).",
        "targets": "Debated ideas", "basis": "Basis of score changes",
        "NEW_ARGUMENT": "new argument", "PEER_PERSUASION": "persuaded by the other judge",
        "ERROR_CORRECTION": "corrected own error",
        "unresolved": "Still disputed after debate", "gapChange": "Mean judge gap before -> after debate",
        "changeTable": "Score changes", "judge": "Judge", "criterion": "Criterion", "change": "Change",
        "rationale": "Rationale", "noChanges": "No scores were changed in the debate.",
        "byPerspective": "Results by perspective", "meanFinal": "Mean final score", "ideas": "Ideas",
        "metrics": "Process metrics", "gapR1": "Mean judge gap - round 1", "gapPost": "Mean judge gap - after debate",
        "gapR2": "Mean judge gap - rescoring", "drift": "Mean change of each judge's total, rescoring vs. after debate",
        "caveats": "Caveats",
        "cavAI": "Scores come from AI judges. Treat them as structured, argued opinions, not ground truth; validate the top ideas with real people.",
        "cavLenient": "Rescoring uses the same judges, so part of any increase after revision may be leniency rather than improvement.",
        "cavSingle": "Isolation was simulated in a single context: one model played every role in turn, so perspectives were not fully independent and judges could know who wrote what.",
        "cavSub": "Roles ran as separate subagents that communicated only through files; anonymity relied on access rules, not technical enforcement.",
        "dash": "-",
    },
    "ko": {
        "title": "IDEA ARENA 보고서", "topic": "주제", "constraints": "제약", "none": "(없음)",
        "setup": "구성", "preset": "프리셋", "depth": "깊이", "isolation": "격리 방식",
        "generators": "관점(생성자)", "judges": "심사위원", "criteria": "평가 기준",
        "top": "TOP {n}", "idea": "아이디어", "perspective": "관점", "final": "최종",
        "r1": "1차", "post": "토론 후", "gap": "심사 격차",
        "problem": "문제", "audience": "대상", "approach": "방식", "differentiation": "차별점",
        "verdicts": "심사위원 판단", "strengths": "강점", "weaknesses": "약점",
        "risks": "리스크 / 실패 시나리오", "critical": "제기된 중대 이슈",
        "validate": "먼저 검증할 가설", "firstSteps": "첫 단계", "plan": "실행 계획",
        "changes": "피드백 반영 내역", "rejected": "작성자가 반박한 피드백(근거 포함)",
        "full": "전체 순위", "debate": "토론",
        "noDebate": "불일치 기준을 넘은 아이디어가 없어 토론이 필요하지 않았습니다.",
        "quickSkip": "토론·개선·재평가는 생략했습니다(깊이: quick).",
        "targets": "토론 대상", "basis": "점수 변경 근거",
        "NEW_ARGUMENT": "새 논거", "PEER_PERSUASION": "상대 심사위원 논거 수용",
        "ERROR_CORRECTION": "자기 오류 정정",
        "unresolved": "토론 후에도 갈린 아이디어", "gapChange": "평균 심사 격차 (토론 전 -> 후)",
        "changeTable": "점수 변경", "judge": "심사위원", "criterion": "기준", "change": "변경",
        "rationale": "근거", "noChanges": "토론에서 바뀐 점수가 없습니다.",
        "byPerspective": "관점별 성적", "meanFinal": "최종 점수 평균", "ideas": "아이디어",
        "metrics": "과정 지표", "gapR1": "평균 심사 격차 - 1차", "gapPost": "평균 심사 격차 - 토론 후",
        "gapR2": "평균 심사 격차 - 재평가", "drift": "심사위원별 총점 평균 변화 (재평가 - 토론 후)",
        "caveats": "유의 사항",
        "cavAI": "점수는 AI 심사위원의 판단입니다. 근거가 붙은 의견으로 보고, 상위 아이디어는 실제 사람에게 검증하세요.",
        "cavLenient": "재평가는 같은 심사위원이 하므로, 개선 후 점수 상승의 일부는 실제 개선이 아니라 관대화일 수 있습니다.",
        "cavSingle": "격리는 단일 컨텍스트에서 모사했습니다. 한 모델이 모든 역할을 차례로 맡았기 때문에 관점이 완전히 독립적이지 않고, 심사위원이 작성자를 알 수 있었습니다.",
        "cavSub": "각 역할은 파일로만 소통하는 별도 서브에이전트로 실행했습니다. 익명성은 기술적 차단이 아니라 접근 규칙으로 유지했습니다.",
        "dash": "-",
    },
}


def dedupe(items):
    seen, out = set(), []
    for x in items:
        k = x.strip()
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def step_final(cfg, paths):
    L = LABELS[lang_code(cfg["language"])]
    ids, mapping = mapping_ids(paths)
    standard = cfg["depth"] == "standard"
    agg1 = read_json(paths, paths.aggregate(1))
    res = read_json(paths, paths.resolution) if standard and paths.resolution.exists() else None
    agg2 = read_json(paths, paths.aggregate(2)) if standard and paths.aggregate(2).exists() else None
    final = agg2 or (res["postDebate"] if res else agg1)
    r1 = load_evals(cfg, paths, 1, ids)
    r2e = load_evals(cfg, paths, 2, ids) if agg2 else None
    gens = {g: read_json(paths, paths.gen(g)) for g in gen_ids(cfg)}
    revs = {}
    if agg2:
        for g in gen_ids(cfg):
            for rv in read_json(paths, paths.revision(g))["revisions"]:
                revs[rv["ideaId"]] = rv
    owner = {e["ideaId"]: e for e in mapping["entries"]}
    by1 = {i["ideaId"]: i for i in agg1["ideas"]}
    byp = {i["ideaId"]: i for i in res["postDebate"]["ideas"]} if res else {}
    ranked = rank_ideas(cfg, final["ideas"])
    gname = {g["id"]: g["name"] for g in cfg["generators"]}
    jname = {j["id"]: j["name"] for j in cfg["judges"]}
    clabel = {c["id"]: c["label"] for c in cfg["criteria"]}

    def idea_of(iid):
        if iid in revs:
            return revs[iid]["idea"]
        e = owner[iid]
        return gens[e["generatorId"]]["ideas"][e["index"]]

    rows = []
    for n, i in enumerate(ranked, 1):
        iid = i["ideaId"]
        rows.append({"rank": n, "ideaId": iid, "title": idea_of(iid)["title"],
                     "generatorId": owner[iid]["generatorId"], "perspective": gname[owner[iid]["generatorId"]],
                     "score": i["score"], "judgeGap": i["totalGap"],
                     "trajectory": {"round1": by1[iid]["score"],
                                    "postDebate": byp[iid]["score"] if res else None,
                                    "rescoring": i["score"] if agg2 else None},
                     "judgeTotals": {jx["judgeId"]: jx["total"] for jx in i["judges"]}})

    by_gen = []
    for g in gen_ids(cfg):
        mine = [r for r in rows if r["generatorId"] == g]
        by_gen.append({"generatorId": g, "perspective": gname[g],
                       "meanFinal": r2(sum(r["score"] for r in mine) / len(mine)),
                       "ideas": [r["ideaId"] for r in mine], "bestRank": min(r["rank"] for r in mine)})

    drift = None
    if agg2 and res:
        drift = {}
        for j in judge_ids(cfg):
            d = [next(x for x in a2["judges"] if x["judgeId"] == j)["total"] -
                 next(x for x in byp[a2["ideaId"]]["judges"] if x["judgeId"] == j)["total"] for a2 in agg2["ideas"]]
            drift[j] = r2(sum(d) / len(d))

    srcs = [paths.config, paths.mapping, paths.aggregate(1)] + [paths.gen(g) for g in gen_ids(cfg)]
    if res:
        srcs.append(paths.resolution)
    if agg2:
        srcs += [paths.aggregate(2)] + [paths.revision(g) for g in gen_ids(cfg)]
    ranking = {"runId": cfg["runId"], "topic": cfg["topic"], "depth": cfg["depth"], "isolation": cfg["isolation"],
               "finalStage": "rescoring" if agg2 else ("postDebate" if res else "round1"),
               "ranking": rows, "byPerspective": by_gen,
               "debate": None if not res else {"targets": [c for c in agg1["disagreements"]],
                                               "basisCounts": res["basisCounts"], "unresolved": res["unresolved"],
                                               "changes": len(res["changes"])},
               "metrics": {"meanGapRound1": agg1["meanTotalGap"],
                           "meanGapPostDebate": res["meanTotalGapAfter"] if res else None,
                           "meanGapRescoring": agg2["meanTotalGap"] if agg2 else None,
                           "judgeDriftRescoring": drift},
               "_sources": paths.sources(srcs)}

    # ---------- markdown
    md = []
    a = md.append
    a(f"# {L['title']}: {cfg['topic']}\n")
    a(f"- **{L['constraints']}**: " + (" / ".join(cfg["constraints"]) if cfg["constraints"] else L["none"]))
    a(f"- **{L['setup']}**: {L['preset']} `{cfg.get('preset', 'custom')}` · {L['depth']} `{cfg['depth']}` · "
      f"{L['isolation']} `{cfg['isolation']}` · run `{cfg['runId']}`")
    a(f"- **{L['generators']}**: " + ", ".join(f"{g['name']} ({ideas_for(cfg, g['id'])})" for g in cfg["generators"]))
    a(f"- **{L['judges']}**: " + ", ".join(j["name"] for j in cfg["judges"]))
    a(f"- **{L['criteria']}**: " + ", ".join(f"{c['label']} {r2(c['weight']):g}%" for c in cfg["criteria"]) +
      f" (0-{cfg['scoring']['maxScore']})\n")

    def table(rs):
        head = f"| # | {L['idea']} | {L['perspective']} | {L['final']} | {L['r1']} |"
        sep = "|---|---|---|---:|---:|"
        if res:
            head += f" {L['post']} |"
            sep += "---:|"
        head += f" {L['gap']} |"
        sep += "---:|"
        out = [head, sep]
        for r in rs:
            line = (f"| {r['rank']} | {r['ideaId']} {r['title']} | {r['perspective']} | **{fmt(r['score'])}** | "
                    f"{fmt(r['trajectory']['round1'])} |")
            if res:
                line += f" {fmt(r['trajectory']['postDebate'])} |"
            line += f" {fmt(r['judgeGap'])} |"
            out.append(line)
        return out

    top_n = min(cfg["scoring"]["topN"], len(rows))
    a(f"## {L['top'].format(n=top_n)}\n")
    md.extend(table(rows[:top_n]))
    a("")
    final_evals = r2e or r1
    for r in rows[:top_n]:
        iid = r["ideaId"]
        idea = idea_of(iid)
        a(f"### {r['rank']}. {idea['title']} ({iid}) - {fmt(r['score'])}\n")
        a(f"> {idea['oneLiner']}\n")
        a(f"- **{L['problem']}**: {idea['problem']}")
        a(f"- **{L['audience']}**: {idea['audience']}")
        a(f"- **{L['approach']}**: {idea['approach']}")
        a(f"- **{L['differentiation']}**: {idea['differentiation']}")
        for k, v in (idea.get("details") or {}).items():
            a(f"- **{k}**: {v if isinstance(v, str) else '; '.join(v)}")
        a(f"\n**{L['verdicts']}**\n")
        for j in judge_ids(cfg):
            ev = final_evals[j][iid]
            tot = next(x for x in next(i for i in final["ideas"] if i["ideaId"] == iid)["judges"] if x["judgeId"] == j)["total"]
            a(f"- *{jname[j]}* ({fmt(tot)}): {ev['summary']}")
            if r2e and ev.get("changeFromPrevious"):
                a(f"  - {ev['changeFromPrevious']}")
        sections = [
            (L["strengths"], dedupe(sum((final_evals[j][iid]["strengths"] for j in judge_ids(cfg)), []))),
            (L["risks"], dedupe(sum((final_evals[j][iid]["risks"] for j in judge_ids(cfg)), []))),
            (L["critical"], dedupe(sum((final_evals[j][iid].get("criticalIssues", []) for j in judge_ids(cfg)), []))),
            (L["validate"], dedupe(idea["assumptions"] +
                                   sum((final_evals[j][iid].get("hypotheses", []) for j in judge_ids(cfg)), []))),
            (L["firstSteps"], idea["firstSteps"]),
        ]
        for title, items in sections:
            if items:
                a(f"\n**{title}**\n")
                md.extend(f"- {x}" for x in items)
        if idea.get("plan"):
            a(f"\n**{L['plan']}**\n")
            md.extend(f"- **{s['stage']}** {s['goal']} ({'; '.join(s['deliverables'])})" for s in idea["plan"])
        if iid in revs:
            a(f"\n**{L['changes']}**\n")
            md.extend(f"- {c['change']} <- {c['addresses']}" for c in revs[iid]["changelog"])
            if revs[iid].get("rejectedFeedback"):
                a(f"\n**{L['rejected']}**\n")
                md.extend(f"- {x['feedback']} -> {x['reason']}" for x in revs[iid]["rejectedFeedback"])
        a("")

    a(f"## {L['full']}\n")
    md.extend(table(rows))
    a("")

    a(f"## {L['debate']}\n")
    if not standard:
        a(L["quickSkip"] + "\n")
    elif not agg1["disagreements"]:
        a(L["noDebate"] + "\n")
    else:
        a(f"- **{L['targets']}**: " + ", ".join(agg1["disagreements"]))
        bc = res["basisCounts"]
        a(f"- **{L['basis']}**: " + ", ".join(f"{L[b]} {bc[b]}" for b in BASES))
        a(f"- **{L['unresolved']}**: " + (", ".join(res["unresolved"]) if res["unresolved"] else L["none"]))
        a(f"- **{L['gapChange']}**: {fmt(res['meanTotalGapBefore'])} -> {fmt(res['meanTotalGapAfter'])}\n")
        if res["changes"]:
            a(f"**{L['changeTable']}**\n")
            a(f"| {L['idea']} | {L['judge']} | {L['criterion']} | {L['change']} | {L['basis']} | {L['rationale']} |")
            a("|---|---|---|---|---|---|")
            for ch in res["changes"]:
                a(f"| {ch['ideaId']} | {jname[ch['judgeId']]} | {clabel[ch['criterion']]} | {ch['from']} -> {ch['to']} | "
                  f"{L[ch['basis']]} | {ch['rationale'].replace('|', '/')} |")
            a("")
        else:
            a(L["noChanges"] + "\n")

    a(f"## {L['byPerspective']}\n")
    a(f"| {L['perspective']} | {L['meanFinal']} | {L['ideas']} |")
    a("|---|---:|---|")
    for b in sorted(by_gen, key=lambda x: (-x["meanFinal"], x["generatorId"])):
        a(f"| {b['perspective']} | {fmt(b['meanFinal'])} | " +
          ", ".join(f"#{next(r['rank'] for r in rows if r['ideaId'] == i)} {i}" for i in b["ideas"]) + " |")
    a("")

    a(f"## {L['metrics']}\n")
    a(f"- {L['gapR1']}: {fmt(agg1['meanTotalGap'])}")
    if res:
        a(f"- {L['gapPost']}: {fmt(res['meanTotalGapAfter'])}")
    if agg2:
        a(f"- {L['gapR2']}: {fmt(agg2['meanTotalGap'])}")
    if drift:
        a(f"- {L['drift']}: " + ", ".join(f"{jname[j]} {drift[j]:+.1f}" for j in judge_ids(cfg)))
    a("")
    a(f"## {L['caveats']}\n")
    a(f"- {L['cavAI']}")
    if agg2:
        a(f"- {L['cavLenient']}")
    a(f"- {L['cavSingle'] if cfg['isolation'] == 'single-context' else L['cavSub']}")
    report = "\n".join(md).rstrip() + "\n"

    write_once(paths, paths.ranking, ranking)
    write_once(paths, paths.report, report)
    return [f"FINALIZING: ranking and report written -> {paths.rel(paths.report)}"]


AUTO_STEPS = {"BLINDING": step_blind, "AGGREGATING": step_aggregate1, "RESOLVING": step_resolve,
              "BLINDING_V2": step_blind2, "AGGREGATING_V2": step_aggregate2, "FINALIZING": step_final}

# Which agent files does each automatic step consume (for `check`)?
CONSUMES = {"BLINDING": "GENERATING", "AGGREGATING": "SCORING", "RESOLVING": "DEBATING",
            "BLINDING_V2": "REVISING", "AGGREGATING_V2": "RESCORING"}


# --------------------------------------------------------------------------- briefs

def fence(obj):
    return "```json\n" + dumps(obj).rstrip() + "\n```"


def idea_template(cfg, with_plan):
    h = dict(DEFAULT_HINTS, **(cfg.get("fieldHints") or {}))
    t = {k: h[k] for k in CORE_TEXT}
    t["firstSteps"] = [h["firstSteps"]]
    t["assumptions"] = ["[hypothesis] an assumption that is not yet verified"]
    if with_plan:
        t["plan"] = [{"stage": cfg.get("planHint") or "Step 1", "goal": "goal of this stage",
                      "deliverables": ["concrete output"]}]
    return t


def anchors(mx):
    if mx == 5:
        return "0 = absent or fatal, 1 = poor, 2 = weak, 3 = adequate, 4 = strong, 5 = exceptional"
    return f"0 = absent or fatal ... {mx} = exceptional; use the whole range"


def brief(cfg, paths, aid):
    ag = agent(cfg, aid)
    if not ag:
        raise ArenaError(f"unknown agent '{aid}'. Agents: generators {gen_ids(cfg)}, judges {judge_ids(cfg)}")
    ph = phase(cfg, paths)
    is_gen = aid in gen_ids(cfg)
    role = "generator" if is_gen else "judge"
    P = lambda p: str(p)  # absolute path for agents
    cons = "\n".join(f"- {c}" for c in cfg["constraints"]) or "- (none)"
    head = (f"# IDEA ARENA - {ag['name']} ({role} `{aid}`) - phase {ph}\n\n"
            f"**Topic:** {cfg['topic']}\n\n**Constraints:**\n{cons}\n\n"
            f"**Output language:** write every text value in {cfg['language']}. Keep JSON keys and enum values in English.\n\n"
            f"**Run directory:** `{paths.d}`\n\n"
            f"## Your perspective\n{ag['lens']}\n")
    done = ("\n## When you finish\nCheck that the file is valid JSON. Then reply with only the path you wrote and the word "
            "DONE. Do not summarize your ideas or scores in the reply - other roles must learn about them only through "
            "the files.\n")
    mx = cfg["scoring"]["maxScore"]
    crit_lines = "\n".join(f"- `{c['id']}` {c['label']} (weight {r2(c['weight']):g}%): {c['description']}"
                           for c in cfg["criteria"])
    honesty = ("- Do not invent facts: market sizes, statistics, prices, citations, competitor claims or legal "
               "statements you cannot verify go in as explicit hypotheses, never as facts.")

    if is_gen and ph == "GENERATING":
        n = ideas_for(cfg, aid)
        return head + f"""
## Task
Write exactly {n} idea(s) for the topic from your perspective and save them to:
`{P(paths.gen(aid))}`

## Rules
- Work independently. Do not open other files in `private/generations/`, or anything under `blind/`, `evaluations/`, `debate/`.
- Your perspective should shape the ideas; ideas from different perspectives are meant to compete, not converge.
- If you write more than one idea, make them genuinely different directions, not variants of one idea.
- Respect the constraints. A brilliant idea that ignores them will be scored down.
{honesty} Put them in `assumptions`, prefixed with "[hypothesis]" (or the equivalent in the output language).
- Never mention your role, perspective name or "agent/generator" in the idea text: ideas are judged anonymously.
- `authorNotes` (optional) is private and never shown to judges. `details` (optional) is an object of extra
  domain-specific fields (string or list-of-string values) shown to judges.

## Format
{fence({"generatorId": aid, "ideas": [idea_template(cfg, False)] + (["...more ideas, same shape"] if n > 1 else [])})}
""" + done

    if is_gen and ph == "REVISING":
        return head + f"""
## Task
1. Read the feedback on your ideas: `{P(paths.feedback(aid))}` (it contains your original ideas, the judges'
   scores after debate, their rationales, risks, critical issues and debate positions).
2. Revise every one of your ideas once and save to: `{P(paths.revision(aid))}`

## Rules
- Fix what the judges convincingly showed to be weak. For each change, add a `changelog` entry: what changed and which
  feedback (judge + criterion or point) it addresses.
- Do not accept feedback just because a judge said it. If you disagree, keep your design and explain why in
  `rejectedFeedback`. Do not dilute your perspective to please the judges.
- Add a `plan`: concrete stages that fit the constraints (team, time, budget). Each stage has a goal and deliverables.
- Keep the idea's identity; this is a revision, not a replacement.
{honesty}
- Never mention your role or perspective name in the idea text. Do not edit your original generation file.

## Format
{fence({"generatorId": aid, "revisions": [{"ideaId": "IDEA-00X", "idea": idea_template(cfg, True),
         "changelog": [{"change": "what changed", "addresses": "which feedback it answers"}],
         "rejectedFeedback": [{"feedback": "feedback you did not accept", "reason": "why"}]}]})}
Include one entry per idea in your feedback file ({len(read_json(paths, paths.feedback(aid))['ideas']) if paths.feedback(aid).exists() else 'all'} total).
""" + done

    access = ("- You may read: `blind/`, `evaluations/`, `debate/`, `config.json`.\n"
              "- Never read `private/` (it holds authorship and author-only material). Do not try to guess who wrote an idea.")
    ids = mapping_ids(paths)[0] if paths.mapping.exists() else []

    if not is_gen and ph in ("SCORING", "RESCORING"):
        rnd = 1 if ph == "SCORING" else 2
        extra = ("- Score independently. Do not open other judges' files in `evaluations/round-1/`." if rnd == 1 else
                 f"- These are revised ideas (v2). Read each idea's `changelog`, `rejectedFeedback` and `plan`.\n"
                 f"- You may look at your own round-1 file and the debate files, but score the revision on its own merits. "
                 f"Do not reward change for its own sake, and do not penalize a well-argued rejection of feedback.\n"
                 f"- `changeFromPrevious` is required: what changed in your judgment versus round 1, and why.")
        ev = {"ideaId": ids[0] if ids else "IDEA-001",
              "scores": {c["id"]: {"score": 3, "rationale": f"why this {c['label']} score"} for c in cfg["criteria"]},
              "strengths": ["..."], "weaknesses": ["..."], "risks": ["concrete way this could fail"],
              "criticalIssues": [], "hypotheses": ["[hypothesis] a judgment you could not verify"],
              "summary": "one-sentence verdict"}
        if rnd == 2:
            ev["changeFromPrevious"] = "what changed in your judgment and why"
        return head + f"""
## Task
Evaluate all {len(ids)} ideas in `{P(paths.d / 'blind' / f'v{rnd}')}` ({', '.join(ids)}) and save to:
`{P(paths.eval(rnd, aid))}`

## Criteria (integer 0-{mx} each; {anchors(mx)})
{crit_lines}

## Rules
{access}
{extra}
- Score every criterion for every idea, including criteria outside your perspective, with a specific rationale.
  Your perspective decides what you look hardest at, not which criteria you skip.
- Use the whole scale. Compare ideas against each other; do not give everything the same safe score.
- `risks` is required: concrete failure scenarios. Put blocking problems (fatal flaws, unverified core assumptions)
  in `criticalIssues`; every critical issue sends the idea to debate.
{honesty} Put them in `hypotheses`.

## Format (one entry per idea in `evaluations`)
{fence({"judgeId": aid, "round": rnd, "evaluations": [ev, "...one per idea"]})}
""" + done

    if not is_gen and ph == "DEBATING":
        agenda = read_json(paths, paths.agenda)
        others = [j for j in judge_ids(cfg) if j != aid]
        tlist = "\n".join(f"- {t['ideaId']} (total gap {t['totalGap']}; " +
                          ", ".join(x["type"].lower() + (f" {x.get('criterion')}" if x.get("criterion") else "")
                                    for x in t["reasons"]) + ")" for t in agenda["targets"])
        first = agenda["targets"][0]["ideaId"] if agenda["targets"] else "IDEA-00X"
        c0 = cfg["criteria"][0]["id"]
        return head + f"""
## Task
The judges disagreed on these ideas (largest gap first):
{tlist}

1. Read the agenda `{P(paths.agenda)}`, your own round-1 file `{P(paths.eval(1, aid))}`,
   the other judge(s): {', '.join(f'`{P(paths.eval(1, j))}`' for j in others)},
   and the ideas in `{P(paths.d / 'blind' / 'v1')}`.
2. For every agenda item write your position and save to: `{P(paths.debate(aid))}`

## Rules
{access}
- The goal is not agreement. If your reasoning holds, keep your score (`MAINTAIN`) and say precisely where the other
  judge's argument is weak in `rebuttal`. Name what you do accept in `concessions`.
- Change a score only when an argument is actually stronger than yours. Then stance is `REVISE`, `from` must equal your
  round-1 score, and `basis` must be honest:
  `NEW_ARGUMENT` (you found a new reason yourself), `PEER_PERSUASION` (the other judge convinced you - say which
  argument), `ERROR_CORRECTION` (you made a mistake in round 1).
- One round only. Do not edit your round-1 file.

## Format (one entry per agenda item)
{fence({"judgeId": aid, "round": 1, "entries": [{"ideaId": first, "position": "core reason for your scores",
        "rebuttal": "where the other judge is wrong or weak", "concessions": ["what you accept"],
        "scoreChanges": [{"criterion": c0, "from": 2, "to": 3, "basis": "NEW_ARGUMENT", "rationale": "why"}],
        "stance": "REVISE"}]})}
(With no score change: `"scoreChanges": []` and `"stance": "MAINTAIN"`.)
""" + done

    return head + f"\nNo work for `{aid}` in phase {ph}. " + (
        "Run `arena.py next`." if ph in AUTO_STEPS else "Wait for the orchestrator.") + "\n"


# --------------------------------------------------------------------------- commands

def default_root():
    out = Path("/mnt/user-data/outputs")
    if out.is_dir():
        return out / "idea-arena"
    return Path.cwd() / "idea-arena-runs"


def slug(s):
    t = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return t[:24].strip("-")


def cmd_presets(a):
    pr = load_presets()
    for name, p in pr.items():
        print(f"{name:10} {p['label']}")
        print(f"{'':10} generators: " + ", ".join(f"{g['id']}" for g in p["generators"]) +
              " | judges: " + ", ".join(j["id"] for j in p["judges"]))
        print(f"{'':10} criteria: " + ", ".join(f"{c['id']} {c['weight']}" for c in p["criteria"]))
    return 0


def subset(items, wanted, kind):
    if not wanted:
        return items
    want = [w.strip() for w in wanted.split(",") if w.strip()]
    by = {i["id"]: i for i in items}
    bad = [w for w in want if w not in by]
    if bad:
        raise ArenaError(f"unknown {kind} {bad}; preset has {list(by)}")
    return [by[w] for w in want]


def cmd_init(a):
    pr = load_presets()
    if a.preset not in pr:
        raise ArenaError(f"unknown preset '{a.preset}'. Available: {', '.join(pr)}")
    p = pr[a.preset]
    lc = lang_code(a.language)
    ts = time.strftime("%Y%m%d-%H%M%S")
    run_id = a.run_id or "-".join(x for x in [ts, slug(a.topic) or "arena",
                                              hashlib.sha256(a.topic.encode("utf-8")).hexdigest()[:4]] if x)
    d = Path(a.dir) if a.dir else (Path(a.root) if a.root else default_root()) / run_id
    paths = Paths(d)
    if paths.config.exists():
        raise ArenaError(f"{paths.config} already exists - use that run (status/next) or choose another --dir")

    def person(x):
        return {"id": x["id"], "name": pick_label(x["name"], lc), "lens": x["lens"]}

    cfg = {
        "arenaVersion": ARENA_VERSION,
        "runId": run_id,
        "topic": a.topic.strip(),
        "constraints": [c.strip() for c in (a.constraint or []) if c.strip()],
        "language": a.language,
        "preset": a.preset,
        "depth": a.depth,
        "isolation": a.isolation,
        "ideasPerGenerator": a.ideas,
        "generators": [person(g) for g in subset(p["generators"], a.generators, "generators")],
        "judges": [person(j) for j in subset(p["judges"], a.judges, "judges")],
        "criteria": [{"id": c["id"], "label": pick_label(c["label"], lc), "description": c["description"],
                      "weight": c["weight"]} for c in p["criteria"]],
        "scoring": {"maxScore": 5, "totalGapThreshold": 15, "criterionGapThreshold": 2, "topN": 3},
        "fieldHints": p.get("fieldHints", {}),
        "planHint": p.get("planHint", "Step 1"),
    }
    errs = validate_config(cfg)
    if errs:
        raise ArenaError("invalid config:\n  - " + "\n  - ".join(errs))
    write_text(paths.config, dumps(cfg))
    total = sum(ideas_for(cfg, g) for g in gen_ids(cfg))
    print(f"Created run {run_id}")
    print(f"Run directory: {paths.d}")
    print(f"Preset {a.preset} | depth {a.depth} | isolation {a.isolation} | {total} ideas from "
          f"{len(cfg['generators'])} perspectives | {len(cfg['judges'])} judges")
    print("You may edit config.json (personas, criteria, weights, thresholds) until the first `next` blinds the ideas.")
    print(f"Next: arena.py brief --dir \"{paths.d}\" --agent <generator>   for each of: {', '.join(gen_ids(cfg))}")
    return 0


def print_status(cfg, paths):
    ph = phase(cfg, paths)
    print(f"IDEA ARENA | run {cfg['runId']} | {cfg['topic']}")
    print(f"Dir: {paths.d}")
    kind = AGENT_PHASES.get(ph)
    label = (f"waiting for {kind}" if kind else
             "automatic step - run `next`" if ph in AUTO_STEPS else "done")
    print(f"Phase: {ph} ({label}) | depth {cfg['depth']} | isolation {cfg['isolation']}")
    pending = []
    if kind:
        for f, owner in phase_files(cfg, paths, ph):
            ok = f.exists()
            print(f"  [{'x' if ok else ' '}] {paths.rel(f):45} <- {owner}")
            if not ok:
                pending.append(owner)
        if pending:
            print(f"Next: send `brief --agent <id>` to: {', '.join(pending)}; then run `next`.")
        else:
            print("Next: all files present - run `next` to validate and advance.")
    elif ph == "COMPLETED":
        print(f"Report: {paths.report}")
    for w in integrity_warnings(paths):
        print(f"warning: {w}")
    return ph


def cmd_status(a):
    cfg, paths = load(a.dir)
    print_status(cfg, paths)
    return 0


def cmd_brief(a):
    cfg, paths = load(a.dir)
    print(brief(cfg, paths, a.agent))
    return 0


def cmd_check(a):
    cfg, paths = load(a.dir)
    ph = phase(cfg, paths)
    target = ph if ph in AGENT_PHASES else CONSUMES.get(ph)
    errors = []
    if target:
        ids = mapping_ids(paths)[0] if paths.mapping.exists() else []
        for f, owner in phase_files(cfg, paths, target):
            if not f.exists():
                errors.append(f"{paths.rel(f)}: missing (owner: {owner})")
                continue
            if target == "GENERATING":
                errors += validate_generation(cfg, paths, owner)[1]
            elif target in ("SCORING", "RESCORING"):
                errors += validate_evaluation(cfg, paths, owner, 1 if target == "SCORING" else 2, ids)[1]
            elif target == "DEBATING":
                targets = [t["ideaId"] for t in read_json(paths, paths.agenda)["targets"]]
                r1, e1 = validate_evaluation(cfg, paths, owner, 1, ids)
                errors += validate_debate(cfg, paths, owner, targets, r1 or {})[1]
            elif target == "REVISING":
                m = read_json(paths, paths.mapping)
                expected = [e["ideaId"] for e in m["entries"] if e["generatorId"] == owner]
                errors += validate_revision(cfg, paths, owner, expected)[1]
    print(f"Phase {ph}: " + ("checking " + target + " files" if target else "nothing to check"))
    for e in errors:
        print(f"  - {e}")
    for w in integrity_warnings(paths):
        print(f"warning: {w}")
    if errors:
        return 1
    print("OK")
    return 0


def cmd_next(a):
    cfg, paths = load(a.dir)
    while True:
        ph = phase(cfg, paths)
        if ph not in AUTO_STEPS:
            break
        try:
            for line in AUTO_STEPS[ph](cfg, paths):
                print(line)
        except Blocked as b:
            print(f"BLOCKED in {ph}: fix these and run `next` again "
                  "(send each error only to the agent that owns the file):")
            for e in b.errors:
                print(f"  - {e}")
            return 1
    print()
    print_status(cfg, paths)
    return 0


def cmd_report(a):
    cfg, paths = load(a.dir)
    if not paths.report.exists():
        print(f"No report yet (phase {phase(cfg, paths)}).")
        return 1
    print(paths.report.read_text(encoding="utf-8"))
    print(f"\n[report: {paths.report}]\n[ranking: {paths.ranking}]")
    return 0


def main(argv=None):
    setup_stdout()
    ap = argparse.ArgumentParser(prog="arena.py", description="IDEA ARENA orchestrator")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("presets", help="list presets")
    p = sub.add_parser("init", help="create a run")
    p.add_argument("--topic", required=True)
    p.add_argument("--constraint", action="append", help="repeatable")
    p.add_argument("--preset", default="general")
    p.add_argument("--depth", choices=["quick", "standard"], default="standard")
    p.add_argument("--isolation", choices=["subagents", "single-context"], default="subagents")
    p.add_argument("--language", default="English")
    p.add_argument("--ideas", type=int, default=2, help="ideas per generator")
    p.add_argument("--generators", help="comma-separated subset of preset generator ids")
    p.add_argument("--judges", help="comma-separated subset of preset judge ids")
    p.add_argument("--root", help="parent directory for runs")
    p.add_argument("--dir", help="exact run directory")
    p.add_argument("--run-id")
    for name in ("status", "check", "next", "report"):
        q = sub.add_parser(name)
        q.add_argument("--dir", required=True)
    q = sub.add_parser("brief")
    q.add_argument("--dir", required=True)
    q.add_argument("--agent", required=True)
    a = ap.parse_args(argv)
    if not a.cmd:
        ap.print_help()
        return 2
    try:
        return {"presets": cmd_presets, "init": cmd_init, "status": cmd_status, "brief": cmd_brief,
                "check": cmd_check, "next": cmd_next, "report": cmd_report}[a.cmd](a)
    except Blocked as b:
        for e in b.errors:
            print(f"error: {e}", file=sys.stderr)
        return 1
    except ArenaError as e:
        print(f"error: {e}", file=sys.stderr)
        return e.code


if __name__ == "__main__":
    sys.exit(main())
