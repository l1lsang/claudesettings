---
name: idea-arena
description: Multi-perspective idea tournament. Several independent perspectives generate ideas, anonymous judges score them on weighted criteria, judges debate only where they disagree, authors revise once, judges rescore, and a ranked report with reasons, risks and hypotheses to test is produced. Use this whenever the user wants to brainstorm and also pick the best ideas rigorously, compare or stress-test ideas from several viewpoints, run an idea competition, tournament, red team or debate, or get a top 3 with evidence. Works for any domain - products, services, startups, features, research questions, marketing campaigns, strategy and policy options, process fixes, stories, games, events, names - and for ideas the user brings to be judged and improved. Also trigger on requests such as 아이디어 오케스트레이션, 아이디어 토너먼트, 아이디어 경쟁, 여러 관점으로 아이디어 내고 평가, 아이디어 심사, 브레인스토밍 후 최선안 선정. Not for a single quick suggestion.
---

# Idea Arena

Several perspectives produce ideas on their own, judges score them **without knowing who wrote what**, argue
**only where they disagree**, the authors revise **once**, and the judges rescore. The goal is not consensus.
It is a fair contest between viewpoints that keeps the evidence: every score, every changed score and its reason,
every piece of feedback an author rejected, and every disagreement that survived the debate.

```
GENERATING   each generator writes ideas independently            agents
BLINDING     shuffle + anonymize -> IDEA-001...                    script
SCORING      each judge scores every blind idea independently      agents
AGGREGATING  weighted totals, judge gaps, debate agenda            script
DEBATING     judges argue the disputed ideas, one round            agents   (skipped if no dispute)
RESOLVING    apply score changes, write feedback per author        script
REVISING     each generator revises its own ideas once             agents
BLINDING_V2  anonymize revisions                                   script
RESCORING    judges score the revisions                            agents
FINALIZING   final/ranking.json + final/report.md                  script
```
Depth `quick` goes straight from AGGREGATING to FINALIZING (no debate, revision or rescoring).

## The script

`scripts/arena.py` (Python 3.8+, standard library only) does all the bookkeeping: validation, anonymization,
score math, agendas, feedback packets and the report. Run it as `python3 <skill-dir>/scripts/arena.py ...`
(on Windows usually `python`). `<skill-dir>` is the folder containing this file.

| Command | What it does |
|---|---|
| `presets` | List domain presets |
| `init --topic ... [--constraint ...]... [--preset P] [--depth quick\|standard] [--isolation subagents\|single-context] [--language L] [--ideas N]` | Create a run and print its directory |
| `status --dir D` | Current phase, which files are pending and who owns them |
| `brief --dir D --agent ID` | The full, self-contained instructions for that agent in the current phase |
| `next --dir D` | Validate the finished phase and run every automatic step up to the next agent phase |
| `check --dir D` | Validate only, change nothing |
| `report --dir D` | Print the final report |

The phase is derived from which files exist, so a run can always be resumed with `status`.
Exit codes: `0` ok, `1` blocked (fix the listed files), `2` usage or config error, `3` integrity conflict.

Only the script writes derived files (`private/mapping.json`, `blind/`, `aggregate.json`, `debate/agenda.json`,
`debate/resolution.json`, `private/feedback/`, `final/`). They are write-once and record hashes of their
inputs, so do not create or edit them by hand, and do not edit an agent's file after `next` has consumed it.
That is what keeps the original ideas and first scores trustworthy next to the revised ones.

If Python is truly unavailable, follow `references/file-formats.md` (manual mode).

## Step 1 - Set up the run

1. **Read the request for:** topic, constraints (team, time, budget, audience, must / must-not), the user's
   language, and whether they brought their own ideas. Ask one short question only if the topic itself is
   unclear; otherwise choose sensible defaults and say what you chose.
2. **Pick a preset** that fits the domain (run `presets` to see the generators, judges and criteria):

   | preset | for |
   |---|---|
   | `product` | products, services, apps, startups, features |
   | `research` | research questions, theses, experiments |
   | `marketing` | campaigns, content, brand, growth |
   | `strategy` | business decisions, policy, process, organization |
   | `creative` | stories, games, events, art, names, concepts |
   | `general` | anything else |

3. **Pick depth:** `standard` by default; `quick` if the user wants something fast or cheap.
4. **Pick isolation honestly:** `subagents` if you can launch subagents (an Agent / Task tool), otherwise
   `single-context`. The report states which one was used.
5. **Workspace:** by default `init` creates the run under `/mnt/user-data/outputs/idea-arena/` when that folder
   exists (claude.ai, downloadable) and under `./idea-arena-runs/` otherwise. Use `--dir` to choose.
6. Run `init`, passing `--language` as the user's language (e.g. `Korean`). If the user wants different
   personas, criteria, weights, more judges, or to enter their own ideas, edit `config.json` now, before the first
   `next` (see `references/config.md`).
7. Tell the user in two or three lines: perspectives, judges, criteria, depth. Then continue without waiting,
   unless they asked to review the setup.

## Step 2 - Run the loop

```
status  ->  brief for every pending agent  ->  agents write their files  ->  next  ->  repeat
```
Repeat until `status` says COMPLETED. If `next` reports BLOCKED, give each error only to the agent that owns
that file, have it fix the file, and run `next` again.

### With subagents (best)

- For each pending agent, launch one subagent whose prompt is the `brief` output **verbatim**. Launch all agents
  of a phase in the same turn so they run in parallel. A general-purpose subagent is fine.
- You are the orchestrator, not a participant: do not write ideas or scores, and do not tell anyone what another
  agent concluded. Files are the only channel between roles. A brief already contains everything an agent needs.
- Never ask the agents to agree. Disagreement that survives with good arguments is a result, not a failure.
- Briefs ask agents to reply with just the file path. If you need to fix a file, send that agent its errors.

### Single context (claude.ai and other environments without subagents)

You play every role yourself, one at a time. Independence is weaker, so protect it with discipline:

- **One role per pass.** Run `brief` for the role, follow only that brief, write the file, then move on.
  Write each generator's ideas from its own perspective; do not draft all ideas first and divide them up.
- **Commit before you look.** Write judge A's file completely before starting judge B, and do not reread A's file
  while acting as B. In round 1, score from the text in `blind/`, not from what you remember writing.
- **Never go back.** Do not edit an earlier role's file after the next role has started; the script detects it.
- Keep the chat short: one line per completed step, not the content of every file.

### Rules that hold in both modes, and why

- **One round each of debate, revision and rescoring.** More rounds mostly produce convergence and cost, not
  better ideas.
- **No invented facts.** Market sizes, statistics, prices, citations and competitor claims that cannot be
  verified are recorded as hypotheses. The report turns them into a "validate first" list, which is one of the
  most useful outputs.
- **Honest score changes.** Every debate change is labeled `NEW_ARGUMENT`, `PEER_PERSUASION` or
  `ERROR_CORRECTION`, so conformity can be told apart from real persuasion.
- **Authors may push back.** Revisions record rejected feedback with reasons; judges are told not to penalize a
  well-argued rejection.

## Step 3 - Deliver

When the run is COMPLETED, `final/report.md` (in the user's language for Korean and English labels) and
`final/ranking.json` exist. Share the report file (on claude.ai it is in the outputs folder, so the user can
download it) and give a short summary in the user's language:

1. **Top 3** and why they won, using the judges' reasons, not your own opinion.
2. **What the debate changed:** how many score changes, and the split between new argument, persuasion and error
   correction.
3. **Still disputed:** ideas the judges kept disagreeing on, and what the disagreement was about.
4. **Validate first:** the two or three hypotheses the top ideas depend on most, and the cheapest way to test each.

Do not re-rank or add your own scores. If something in the process looks off (thin rationales, suspicious
uniform scores, a likely authorship leak warning), add a clearly labeled one-line note.

## When things go wrong

- **BLOCKED (exit 1):** a file is missing fields or has wrong values. The error says which file, which path inside
  it and what is expected. Send it to the owner and run `next` again.
- **Integrity conflict (exit 3) or "changed after ... consumed" warning:** an input was edited after it was used.
  Do not delete files to make the error go away. Tell the user which file changed and ask how to proceed.
- **Session interrupted:** run `status` on the run directory. All progress is in files; launch only the agents the
  current phase still needs.
- **Leak warning:** an idea mentions its author's role. The judges have already been given the text, so mention
  it in the final note.

## References

- `references/config.md` - every config field; recipes for custom personas and criteria, bringing the user's own
  ideas, evaluate-only runs, extra judges, thresholds.
- `references/file-formats.md` - JSON formats of every file, scoring formulas, ranking rules, and a manual mode
  for environments without Python.
