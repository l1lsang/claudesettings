import type { Criterion, GeneratorId, JudgeId } from "./constants";

/**
 * 상황별 프리셋. 내부 구조(생성자 3 슬롯, 심사위원 2 슬롯, 평가 항목 5 슬롯, 파일 이름, 점수 계산)는 그대로 두고
 * 각 슬롯의 이름·관점·평가 기준·가중치·표시 이름만 상황에 맞게 바꾼다.
 *
 *   생성자 슬롯 creative / problem / business  → 발산형 / 사람·문제 중심 / 실행·지속형 관점
 *   심사위원 슬롯 feasibility / innovation     → 실행·위험을 보는 쪽 / 가치·새로움을 보는 쪽
 *   평가 슬롯 problemValue(핵심 가치, 동점 처리 기준) · originality · feasibility · mvpTestability · differentiation
 *
 * 가중치 합은 항상 100(가중 점수 0~100). 프리셋 ID는 실행 입력에 저장되므로 바꾸지 않는다.
 */

export const PRESET_IDS = ["general", "product", "research", "marketing", "strategy", "creative"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** preset 필드가 없는 예전 실행은 서비스·창업 프리셋으로 만들어졌다 */
export const LEGACY_PRESET: PresetId = "product";
export const DEFAULT_PRESET: PresetId = "general";

export interface IdeaFieldLabels {
  title: string;
  problem: string;
  targetUsers: string;
  solution: string;
  differentiation: string;
  mvp: string;
  assumptions: string;
  plan: string;
}

export interface Preset {
  id: PresetId;
  name: string;
  description: string;
  /** 이 상황에서 아이디어를 부르는 말 — 프롬프트에 쓴다 */
  kind: string;
  generators: Record<GeneratorId, { name: string; lens: string }>;
  judges: Record<JudgeId, { name: string; lens: string }>;
  criteria: Record<Criterion, { label: string; description: string; weight: number }>;
  fields: IdeaFieldLabels;
  /** 실행 계획의 단위(mvpPlan.week 숫자의 의미): 주 / 월 / 단계 */
  planUnit: string;
}

const PRESETS: Record<PresetId, Preset> = {
  general: {
    id: "general",
    name: "범용",
    description: "무엇이든: 생활, 학습·교육, 커뮤니티, 개인 프로젝트, 여러 분야가 섞인 주제",
    kind: "아이디어",
    generators: {
      creative: { name: "발산 관점", lens: "예상 밖의 각도와 재정의. 주제의 전제를 의심하고, 멀리 떨어진 분야의 방식을 빌려 온다." },
      problem: { name: "사람 중심 관점", lens: "관련된 사람들이 지금 실제로 무엇을 하고, 느끼고, 어디서 막히는지에서 출발한다. 실제 행동에 맞는 아이디어를 낸다." },
      business: { name: "실용 관점", lens: "이미 있는 것으로 바로 시도할 수 있는 단순하고 싸고 튼튼한 아이디어." },
    },
    judges: {
      feasibility: { name: "회의론자 심사위원", lens: "무엇이 잘못될 수 있는지, 무엇이 비현실적인지, 근거 없이 가정한 것이 무엇인지, 실제 비용이 얼마인지 따진다." },
      innovation: { name: "비전가 심사위원", lens: "이 아이디어가 얼마나 큰 도움이 될 수 있는지, 얼마나 새로운지, 무엇으로 자랄 수 있는지 본다." },
    },
    criteria: {
      problemValue: { label: "가치", description: "주어진 목표에 얼마나 도움이 되는가", weight: 25 },
      originality: { label: "독창성", description: "뻔한 답에 비해 얼마나 새로운가", weight: 20 },
      feasibility: { label: "실현 가능성", description: "주어진 제약 안에서 할 수 있는가", weight: 20 },
      mvpTestability: { label: "검증 용이성", description: "작게 시도하고 빨리 판단할 수 있는가", weight: 20 },
      differentiation: { label: "견고성", description: "계획대로 되지 않아도 여전히 작동하는가", weight: 15 },
    },
    fields: {
      title: "아이디어 이름",
      problem: "다루는 목표·문제",
      targetUsers: "누구를 위한 것인가",
      solution: "어떻게 작동하는가",
      differentiation: "뻔한 대안과의 차이",
      mvp: "가장 먼저 해볼 작은 시도",
      assumptions: "검증할 가정",
      plan: "실행 계획",
    },
    planUnit: "단계",
  },

  product: {
    id: "product",
    name: "서비스·창업",
    description: "제품, 서비스, 앱, 스타트업, 기능 아이디어",
    kind: "서비스·제품 아이디어",
    generators: {
      creative: { name: "Creative Agent", lens: "남들이 시도하지 않은 접근, 익숙한 문제를 새로운 방식으로 푸는 아이디어. 단, 독창성이 주제의 제약(팀 규모, 기간)을 무시해도 된다는 뜻은 아니다." },
      problem: { name: "Problem Agent", lens: "사용자가 실제로 반복해서 겪는 구체적 불편. \"누가, 언제, 얼마나 자주, 지금은 어떻게 버티는가\"를 먼저 정의하고 해결책을 만든다. 사용자 행동·빈도·불편 정도에 대한 추정은 assumptions에 \"[가설]\"로 적는다." },
      business: { name: "Business Agent", lens: "사람들이 실제로 쓰고 계속 쓸 이유가 있는가, 초기 사용자를 어떻게 모으는가, MVP 이후에도 유지될 수 있는가(운영·수익 모델). 시장 규모·지불 의사·경쟁사 현황은 확인된 출처가 없으면 assumptions에 \"[가설]\"로 적는다. 숫자를 지어내지 않는다." },
    },
    judges: {
      feasibility: { name: "Feasibility Judge", lens: "주어진 팀 규모와 기간 안에 실제로 만들 수 있는가. 외부 API·데이터 확보·인증·운영 부담 같은 숨은 비용을 찾는다." },
      innovation: { name: "Innovation Judge", lens: "이 문제가 정말 풀 가치가 있는가, 기존 대안(앱·커뮤니티·수작업)과 비교해 무엇이 새로운가. \"이미 있는 것의 재포장\"을 가려낸다. 경쟁 서비스 존재 여부를 확인하지 못했다면 \"없다\"고 단정하지 말고 hypotheses에 가설로 적는다." },
    },
    criteria: {
      problemValue: { label: "문제 해결 가치", description: "문제가 얼마나 아프고 잦고 널리 퍼져 있으며, 아이디어가 실제로 얼마나 덜어 주는가", weight: 25 },
      originality: { label: "독창성", description: "포장이 아니라 접근 자체가 얼마나 새로운가", weight: 20 },
      feasibility: { label: "구현 가능성", description: "주어진 제약 안에서 만들고 운영할 수 있는가", weight: 20 },
      mvpTestability: { label: "MVP 검증 용이성", description: "첫 버전으로 핵심 가설을 얼마나 빠르고 싸게 검증할 수 있는가", weight: 20 },
      differentiation: { label: "차별성", description: "기존 대안 대신 이것을 고를 분명한 이유", weight: 15 },
    },
    fields: {
      title: "서비스 이름",
      problem: "해결하려는 구체적 문제",
      targetUsers: "핵심 사용자",
      solution: "제안하는 해결 방식",
      differentiation: "기존 대안과의 차이",
      mvp: "MVP 핵심 기능",
      assumptions: "미검증 가정",
      plan: "MVP 개발 계획",
    },
    planUnit: "주",
  },

  research: {
    id: "research",
    name: "연구",
    description: "연구 질문, 논문·학위 주제, 실험, 조사 설계",
    kind: "연구 주제",
    generators: {
      creative: { name: "개척 관점", lens: "분야의 경계에 있는 대담한 질문. 문헌·방법·데이터 사이의 예상 밖 연결. 사람들의 믿음을 바꿀 수 있는 질문을 노린다." },
      problem: { name: "임팩트 관점", lens: "결과에서 출발한다. 답이 실무·정책·인접 분야에 중요한 질문을 고르고, 결과에 따라 누가 무엇을 다르게 할지 밝힌다." },
      business: { name: "엄밀성 관점", lens: "깔끔하게 답할 수 있는 질문: 식별 가능한 효과, 구할 수 있는 데이터, 타당한 설계, 분명한 반증 기준. 모호한 큰 질문보다 날카로운 답을 선호한다." },
    },
    judges: {
      feasibility: { name: "방법론 심사위원", lens: "타당도, 식별, 교란 변수, 표본 크기, 데이터 접근, 연구 윤리 승인, 일정과 역량이 현실적인지 본다." },
      innovation: { name: "분야 전문가 심사위원", lens: "기존 문헌 대비 중요성과 새로움. 해당 학계가 관심을 가질까? 이미 답이 나왔거나 답이 뻔한 질문을 가려낸다. 선행 연구 존재 여부를 확인하지 못했다면 단정하지 말고 hypotheses에 적는다." },
    },
    criteria: {
      problemValue: { label: "중요성", description: "답이 분야나 실무에 얼마나 중요한가", weight: 25 },
      originality: { label: "새로움", description: "아직 답이 나오지 않은 새로운 질문이나 방법인가", weight: 20 },
      feasibility: { label: "실행 가능성", description: "제약 안에서 데이터·자원·역량·시간을 확보할 수 있는가", weight: 20 },
      mvpTestability: { label: "엄밀성", description: "설계가 타당하고 믿을 수 있는 답을 낼 수 있는가", weight: 20 },
      differentiation: { label: "명확성", description: "질문이 잘 정의되고 반증 가능하며, 어떤 결과가 답인지 분명한가", weight: 15 },
    },
    fields: {
      title: "연구 제목(가제)",
      problem: "연구 질문과 지식 공백",
      targetUsers: "답이 중요한 대상(학계·실무·의사결정자)",
      solution: "연구 방법·설계·데이터",
      differentiation: "선행 연구와의 차이(확실한 것만)",
      mvp: "파일럿 연구·첫 실험",
      assumptions: "검증할 가정",
      plan: "연구 계획",
    },
    planUnit: "월",
  },

  marketing: {
    id: "marketing",
    name: "마케팅·캠페인",
    description: "캠페인, 콘텐츠, 브랜드, 그로스, 출시 아이디어",
    kind: "마케팅·캠페인 아이디어",
    generators: {
      creative: { name: "파격 관점", lens: "주목을 끄는 의외의 콘셉트. 문화적 훅, 업계에서 아무도 안 쓰는 형식, 사람들이 이야기할 만한 아이디어." },
      problem: { name: "인사이트 관점", lens: "타깃에 대한 날카로운 인사이트(긴장, 습관, 말하지 않은 진실)에서 출발해 메시지를 만든다." },
      business: { name: "그로스 관점", lens: "채널, 퍼널, 측정 가능한 성과. 어떻게 퍼지는지, 결과당 비용이 얼마인지, 어떻게 테스트하고 반복하는지." },
    },
    judges: {
      feasibility: { name: "퍼포먼스 심사위원", lens: "도달, 비용, 주어진 예산·팀으로 실행 가능한지, 측정 가능성, 학습 속도." },
      innovation: { name: "브랜드 전략 심사위원", lens: "브랜드 적합성, 타깃 인사이트의 질, 메시지의 명확성과 기억에 남는 정도, 평판 위험." },
    },
    criteria: {
      problemValue: { label: "타깃 적합성", description: "타깃에 대한 실제 인사이트에 뿌리를 두는가", weight: 25 },
      originality: { label: "독창성", description: "업계에서 눈에 띄고 기억에 남는가", weight: 20 },
      feasibility: { label: "실행 가능성", description: "주어진 예산·팀·일정으로 할 수 있는가", weight: 20 },
      mvpTestability: { label: "측정 가능성", description: "성공 지표가 분명하고, 키우기 전에 작게 테스트할 수 있는가", weight: 20 },
      differentiation: { label: "메시지 명확성", description: "타깃이 핵심을 바로 이해하는가", weight: 15 },
    },
    fields: {
      title: "캠페인·콘셉트 이름",
      problem: "마케팅 문제·목표",
      targetUsers: "타깃과 그들에 대한 인사이트",
      solution: "콘셉트·메시지·채널·실행 방식",
      differentiation: "경쟁사·업계 관행과의 차이",
      mvp: "가장 먼저 해볼 작은 테스트",
      assumptions: "검증할 가정",
      plan: "실행 계획",
    },
    planUnit: "주",
  },

  strategy: {
    id: "strategy",
    name: "전략·정책",
    description: "사업 전략, 의사결정, 공공정책, 프로세스·조직 개선",
    kind: "전략·정책 방안",
    generators: {
      creative: { name: "급진 관점", lens: "목표를 재정의하고 그 뒤의 가정에 도전한다. 현재 방식을 최적화하기보다 판을 바꾸는 방안." },
      problem: { name: "이해관계자 관점", lens: "영향받는 사람들에서 출발한다: 인센티브, 예상 저항, 공정성, 2차 효과. 사람들이 실제로 받아들일 방안." },
      business: { name: "실행가 관점", lens: "기존 인력·시스템·예산으로 다음 주부터 실행할 수 있는 실용적이고 점진적인 방안." },
    },
    judges: {
      feasibility: { name: "리스크 심사위원", lens: "실행 위험, 비용, 의존성, 되돌릴 수 있는지, 실패 양상, 법률·규제 노출." },
      innovation: { name: "임팩트 심사위원", lens: "목표에 미치는 효과의 크기와 지속성, 전략적 일관성, 기회비용." },
    },
    criteria: {
      problemValue: { label: "효과", description: "목표에 미치는 효과의 크기와 지속성", weight: 25 },
      originality: { label: "수용성", description: "영향받는 사람들이 받아들이고 지지할 가능성", weight: 20 },
      feasibility: { label: "실행 가능성", description: "가용 인력·시스템·예산·시간으로 실행할 수 있는가", weight: 20 },
      mvpTestability: { label: "리스크 관리", description: "점수가 높을수록 손실 위험이 작거나 잘 관리되고, 실패해도 되돌릴 수 있다", weight: 20 },
      differentiation: { label: "비용 효율", description: "투입한 돈·시간·관심 대비 효과", weight: 15 },
    },
    fields: {
      title: "방안 이름",
      problem: "다루는 목표·문제",
      targetUsers: "영향받는 사람과 실행 주체",
      solution: "구체적으로 무엇을 하는가",
      differentiation: "현 상태·뻔한 대안과의 차이",
      mvp: "되돌릴 수 있는 첫 단계·시범 사업",
      assumptions: "검증할 가정",
      plan: "단계별 실행 계획",
    },
    planUnit: "단계",
  },

  creative: {
    id: "creative",
    name: "창작·콘텐츠",
    description: "이야기, 게임, 행사, 예술, 공연, 콘텐츠 시리즈, 이름·콘셉트",
    kind: "창작 콘셉트",
    generators: {
      creative: { name: "파격 관점", lens: "놀라운 전제, 장르 충돌, 과감한 형식. \"이런 건 처음 본다\"는 말이 나오는 아이디어." },
      problem: { name: "관객 관점", lens: "타깃 관객이 무엇을 느끼고, 공유하고, 다시 찾을지. 감정적 보상을 먼저 정하고 그것을 전달할 형식을 고른다." },
      business: { name: "완성도 관점", lens: "구조와 실행: 일관된 세계·인물·메커니즘·전개. 깊이 발전시켜도 버티는 아이디어." },
    },
    judges: {
      feasibility: { name: "프로듀서 심사위원", lens: "주어진 자원으로 만들 수 있는지, 관객 호소력, 범위 위험, 완성까지 필요한 것." },
      innovation: { name: "비평가 심사위원", lens: "독창성, 예술적 일관성, 감정의 깊이. 클리셰와 모방을 지적한다." },
    },
    criteria: {
      problemValue: { label: "감정적 울림", description: "관객이 강하게 무언가를 느끼게 하는가", weight: 25 },
      originality: { label: "독창성", description: "전제나 형식이 신선하고 모방이 아닌가", weight: 25 },
      feasibility: { label: "제작 가능성", description: "주어진 자원과 시간으로 만들 수 있는가", weight: 15 },
      mvpTestability: { label: "완결성", description: "내적으로 일관되고 발전시켜도 버티는가", weight: 20 },
      differentiation: { label: "대중성", description: "의도한 관객이 찾아보고 공유할 만한가", weight: 15 },
    },
    fields: {
      title: "가제",
      problem: "관객에게 주는 것(채워 주는 욕구)",
      targetUsers: "타깃 관객",
      solution: "전제·구조·형식·핵심 요소",
      differentiation: "비슷한 작품과의 차이",
      mvp: "첫 프로토타입·초안·샘플",
      assumptions: "검증할 가정",
      plan: "제작 계획",
    },
    planUnit: "단계",
  },
};

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

export function getPreset(id: string | undefined): Preset {
  return PRESETS[isPresetId(id) ? id : LEGACY_PRESET];
}

export function presetWeights(preset: Preset): Record<Criterion, number> {
  return {
    problemValue: preset.criteria.problemValue.weight,
    originality: preset.criteria.originality.weight,
    feasibility: preset.criteria.feasibility.weight,
    mvpTestability: preset.criteria.mvpTestability.weight,
    differentiation: preset.criteria.differentiation.weight,
  };
}

/** 화면·보고서용 이름표 */
export function presetLabels(preset: Preset) {
  return {
    presetId: preset.id,
    presetName: preset.name,
    agents: {
      creative: preset.generators.creative.name,
      problem: preset.generators.problem.name,
      business: preset.generators.business.name,
      feasibility: preset.judges.feasibility.name,
      innovation: preset.judges.innovation.name,
    } as Record<GeneratorId | JudgeId, string>,
    criteria: (Object.keys(preset.criteria) as Criterion[]).map((c) => ({ id: c, label: preset.criteria[c].label })),
    criterionLabels: Object.fromEntries((Object.keys(preset.criteria) as Criterion[]).map((c) => [c, preset.criteria[c].label])) as Record<Criterion, string>,
    fields: preset.fields,
    planUnit: preset.planUnit,
  };
}
export type PresetLabels = ReturnType<typeof presetLabels>;

export function listPresets(): { id: PresetId; name: string; description: string }[] {
  return PRESET_IDS.map((id) => ({ id, name: PRESETS[id].name, description: PRESETS[id].description }));
}
