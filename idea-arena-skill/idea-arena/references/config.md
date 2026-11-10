# config.json reference

`arena.py init` writes `config.json` from a preset. You may edit it freely **until the first `next`**
(that is when ideas get blinded and the config's hash is recorded). After that, edits are reported as integrity
warnings and the recorded results keep using the original. Run `arena.py check --dir D` after editing; it
validates the config.

## Fields

| Field | Meaning |
|---|---|
| `runId` | Run identifier. It also seeds the anonymizing shuffle, so do not change it after blinding. |
| `topic` | The question everyone works on. Be specific; the topic text goes into every brief. |
| `constraints` | List of strings: team, time, budget, audience, must / must-not. Judges score against them. |
| `language` | Language of all text agents write, e.g. `Korean`, `English`, `Japanese`. Korean and English also get localized report labels; other languages get English labels. |
| `preset` | The preset the config was built from (informational). |
| `depth` | `standard` (full pipeline) or `quick` (generate, blind, score, report). |
| `isolation` | `subagents` or `single-context`. Only changes the caveat in the report; be truthful. |
| `ideasPerGenerator` | Default number of ideas each generator writes (1-10). |
| `generators[]` | `{id, name, lens, ideas?}`. `id`: lowercase letters, digits, hyphens. `lens`: the perspective, written as instructions. `ideas` overrides `ideasPerGenerator` for that generator. At least 1. |
| `judges[]` | `{id, name, lens}`. At least 2. Ids must be unique across generators and judges. |
| `criteria[]` | `{id, label, description, weight}`. Weights must sum to 100. `description` is shown to judges, so make it a usable scoring rule. |
| `scoring.maxScore` | Top of the per-criterion integer scale (default 5). |
| `scoring.totalGapThreshold` | An idea goes to debate if two judges' weighted totals differ by at least this (default 15 on a 0-100 scale). |
| `scoring.criterionGapThreshold` | ...or if any single criterion differs by at least this (default 2). |
| `scoring.topN` | How many ideas the report details (default 3). |
| `fieldHints` | Placeholder text in the JSON templates of the briefs, per idea field. Use it to steer what each field should contain for the domain. |
| `planHint` | Example label for revision plan stages, e.g. `Week 1`, `Month 1`, `Phase 1`. |

Every critical issue a judge records also sends that idea to debate.

## Writing good lenses

A lens is an instruction, not a job title. Say what the perspective cares about, where it starts, and what it
refuses to do. Compare:

- weak: `"Marketing expert."`
- strong: `"Start from a sharp audience insight - a tension, habit or unspoken truth - and build the message from
  it. Ignore channel tactics until the insight is right."`

Perspectives should pull in different directions; three lenses that all mean "be practical" produce six similar
ideas. Judges' lenses should cover different failure modes (e.g. "can it be done?" versus "is it worth doing?").

## Recipes

### Bring the user's own ideas

Add a generator for them and set `ideas` to how many the user gave:

```json
{"id": "user", "name": "User-submitted", "ideas": 4,
 "lens": "Advocate for the user's submitted ideas. Represent them faithfully; when revising, strengthen them without changing their core intent."}
```

During GENERATING, write `private/generations/user.json` yourself by transcribing the user's ideas into the
idea format. Transcribe, do not improve: keep their wording, and where a required field is missing, write what
can be fairly inferred and add an assumption such as `"[hypothesis] audience not specified by the user"`.
The other generators still produce their own ideas, so the user's ideas compete with fresh ones. In REVISING,
the `user` generator's brief can be given to a subagent (or done by you) like any other.

### Evaluate only (no new ideas)

Keep only the `user` generator (remove the others), and use `depth: quick` for a pure scoring run or
`standard` to also get debate, revision and rescoring of the user's ideas.

### Custom criteria

Replace `criteria` entirely. Keep 3-7 criteria, write each `description` as a rule a judge can apply, and make
the weights sum to 100. For criteria where "more" is bad (risk, cost), phrase them so that a higher score is
always better, e.g. `riskControl: "Higher = lower or better-managed downside"`.

### More judges

Add entries to `judges` (e.g. a target-user judge, an ethics or legal judge). With more than two judges the gap
is max minus min, so disagreement is detected more often; you may raise the thresholds slightly.

### More or fewer ideas

`--ideas N` at init, or per-generator `ideas`. Total ideas = sum over generators. 6-9 ideas is a good range;
beyond about 12 the judges' attention per idea drops and runs get expensive.

### Mixed domains

Start from the closest preset and swap one generator or judge for a lens from another preset, or write a new
one. Presets are just starting points stored in `assets/presets.json`.

### Stricter or looser debate

Lower `totalGapThreshold` / `criterionGapThreshold` to debate more ideas, raise them to debate only sharp
disagreements.
