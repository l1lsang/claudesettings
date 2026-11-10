# File formats, scoring rules, manual mode

Normally `arena.py brief` prints the exact format each agent needs, and `arena.py next` validates it.
Read this file when debugging a BLOCKED error, or when Python is unavailable and you must run the arena by hand.

## Contents
1. Run directory layout
2. Agent-written files
3. Script-written files
4. Scoring and ranking rules
5. Manual mode (no Python)

## 1. Run directory layout

```
<run>/
├── config.json                          setup (editable until blinding)
├── private/                             judges never read this folder
│   ├── generations/<generator>.json     generator   original ideas
│   ├── mapping.json                     script      IDEA-ID -> generator
│   ├── feedback/<generator>.json        script      judges' feedback on that generator's ideas
│   └── revisions/<generator>.json       generator   revised ideas
├── blind/v1/IDEA-00N.json               script      anonymized originals
├── blind/v2/IDEA-00N.json               script      anonymized revisions
├── evaluations/round-1/<judge>.json     judge
├── evaluations/round-1/aggregate.json   script
├── debate/agenda.json                   script      disputed ideas, largest gap first
├── debate/<judge>.json                  judge
├── debate/resolution.json               script      post-debate scores, change bases, still-disputed
├── evaluations/round-2/<judge>.json     judge
├── evaluations/round-2/aggregate.json   script
└── final/ranking.json, final/report.md  script
```

## 2. Agent-written files

Unknown fields are rejected (catches typos). All text values are non-empty strings.

**Idea** (core shape used everywhere)
```json
{"title": "", "oneLiner": "", "problem": "", "audience": "", "approach": "", "differentiation": "",
 "firstSteps": ["at least one"], "assumptions": ["at least one, e.g. [hypothesis] ..."],
 "details": {"optional extra field": "string or list of strings"}}
```

**private/generations/&lt;generator&gt;.json** - exactly the configured number of ideas; `authorNotes` (optional
string) is private.
```json
{"generatorId": "creative", "ideas": [ {"...idea": "", "authorNotes": "optional"} ]}
```

**evaluations/round-N/&lt;judge&gt;.json** - one entry per idea; `scores` has exactly the configured criteria,
each an integer 0..maxScore. `changeFromPrevious` is required in round 2 and not allowed in round 1.
```json
{"judgeId": "feasibility", "round": 1, "evaluations": [
  {"ideaId": "IDEA-001",
   "scores": {"<criterionId>": {"score": 3, "rationale": ""}},
   "strengths": ["≥1"], "weaknesses": ["≥1"], "risks": ["≥1"],
   "criticalIssues": [], "hypotheses": [], "summary": "",
   "changeFromPrevious": "round 2 only"}]}
```

**debate/&lt;judge&gt;.json** - one entry per agenda item. `from` must equal the judge's round-1 score; `to`
must differ from it; each criterion at most once per entry. `REVISE` if and only if there are score changes.
```json
{"judgeId": "innovation", "round": 1, "entries": [
  {"ideaId": "IDEA-003", "position": "", "rebuttal": "", "concessions": [],
   "scoreChanges": [{"criterion": "<criterionId>", "from": 2, "to": 3,
                     "basis": "NEW_ARGUMENT | PEER_PERSUASION | ERROR_CORRECTION", "rationale": ""}],
   "stance": "MAINTAIN | REVISE"}]}
```

**private/revisions/&lt;generator&gt;.json** - one entry per own idea; the idea also needs `plan`.
```json
{"generatorId": "creative", "revisions": [
  {"ideaId": "IDEA-004",
   "idea": {"...idea": "", "plan": [{"stage": "Week 1", "goal": "", "deliverables": ["≥1"]}]},
   "changelog": [{"change": "", "addresses": ""}],
   "rejectedFeedback": [{"feedback": "", "reason": ""}]}]}
```

## 3. Script-written files

- `mapping.json`: `{"_sources": {...}, "entries": [{"ideaId", "generatorId", "index"}]}`. Order comes from
  sorting `sha256(runId|generatorId|index)`, so it is shuffled but reproducible.
- `blind/v1/*`: `{"ideaId", "version": 1, ...idea core}`. `blind/v2/*` adds `plan`, `changelog`,
  `rejectedFeedback`. No author information, no `authorNotes`.
- `aggregate.json`: per idea - each judge's criterion scores and weighted total, the mean `score`, `totalGap`,
  `criterionGaps`, `disagreementReasons`; plus `disagreements` (ids, largest gap first) and `meanTotalGap`.
- `resolution.json`: `postDebate` (an aggregate with debate changes applied), `changes`, `stances`,
  `basisCounts`, `unresolved`, `meanTotalGapBefore/After`.
- `feedback/<generator>.json`: for each of that generator's ideas - the original, post-debate score, judge gap,
  whether it is still disputed, and per judge: scores (post-debate and round 1), rationales, strengths,
  weaknesses, risks, critical issues, hypotheses, summary, debate position.
- `_sources` in derived files maps each consumed input to its sha256; `status` warns if an input changes later.

## 4. Scoring and ranking rules

- Judge total = Σ (weight_c × score_c / maxScore), a 0-100 number (weights sum to 100). Rounded to 2 decimals.
- Idea score = mean of the judges' totals. Judge gap = max total − min total.
- An idea goes to debate if: gap ≥ `totalGapThreshold`, or any criterion differs by ≥ `criterionGapThreshold`
  between some two judges, or any judge listed a critical issue.
- After debate, an idea is "still disputed" if it was on the agenda and still has a score-gap reason (critical
  issues alone do not count, since debate cannot remove them).
- Final score = rescoring score (standard) or round-1 score (quick).
- Ranking: final score (desc) → smaller judge gap → higher mean on the highest-weight criterion → idea id.
- "Judge drift" in the report = mean change of each judge's total from post-debate to rescoring; a large uniform
  rise across all ideas hints at leniency rather than improvement.

## 5. Manual mode (no Python)

Only when the script cannot run at all. Follow the same phases and file layout, doing the script's steps by hand,
and say in the report that bookkeeping was manual.

1. **Setup:** write `config.json` from a preset in `assets/presets.json` (pick one language for labels).
2. **Generate:** for each generator, write its file from its lens alone (see single-context rules in SKILL.md).
3. **Blind:** list all ideas, order them by an arbitrary but fixed rule you did not choose by quality (e.g.
   alphabetical by the first word of `problem`), number them IDEA-001..., write `mapping.json` and `blind/v1/`
   without author information.
4. **Score:** each judge writes its round-1 file from `blind/v1/` only, one judge fully before the next.
5. **Aggregate:** compute totals, gaps and the agenda with the rules in section 4. Show the arithmetic in a table
   so the user can check it.
6. **Debate / resolve / feedback / revise / blind v2 / rescore:** as in the automatic pipeline.
7. **Report:** follow the section order of the automatic report: top N with details, full ranking with score
   trajectory, debate summary with basis counts, results by perspective, process metrics, caveats.
