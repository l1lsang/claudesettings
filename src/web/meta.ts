import { AGENT_LABELS, CRITERIA, CRITERION_LABELS, GENERATOR_IDS, JUDGE_IDS, SCORE_CHANGE_BASIS_LABELS } from "../domain/constants";
import { DEFAULT_PRESET, listPresets } from "../domain/presets";
import { ArenaPhaseSchema } from "../domain/schemas";

/** 화면이 쓰는 표시용 상수 */
export const META = {
  phases: ArenaPhaseSchema.options.filter((p) => p !== "FAILED"),
  criteria: CRITERIA.map((c) => ({ id: c, label: CRITERION_LABELS[c] })),
  agents: AGENT_LABELS,
  generators: GENERATOR_IDS,
  judges: JUDGE_IDS,
  bases: SCORE_CHANGE_BASIS_LABELS,
  presets: listPresets(),
  defaultPreset: DEFAULT_PRESET,
};
