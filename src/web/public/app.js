// IDEA ARENA 로컬 대시보드 — 읽기 전용. 에이전트가 쓴 텍스트는 모두 textContent로만 넣는다(innerHTML 금지).
"use strict";

const POLL_MS = 4000;
const ui = {
  meta: null,
  runs: [],
  runId: null,
  bundle: null,
  bundleJson: "",
  open: new Set(), // 펼친 아이디어
  version: {}, // ideaId → 1 | 2
  timer: null,
};

// ─── 유틸 ───────────────────────────────────────────────────────
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "vars") for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}
const fmt = (n) => (typeof n === "number" ? n.toFixed(1) : "–");
const signed = (n) => (n > 0 ? "+" : "") + n.toFixed(1);
const time = (ts) => new Date(ts).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "medium" });
const agent = (id) => (ui.meta && ui.meta.agents[id]) || id;
const list = (items, empty = "없음") =>
  items && items.length ? h("ul", { class: "plain-list" }, items.map((s) => h("li", null, s))) : h("span", { class: "muted" }, empty);

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const PHASE_LABEL = {
  CREATED: "생성됨", GENERATING: "아이디어 생성", BLINDING: "익명화", SCORING: "1차 심사", DEBATING: "토론",
  REVISING: "개선", RESCORING: "재평가", FINALIZING: "최종 집계", COMPLETED: "완료", FAILED: "실패",
};
const phaseBadge = (p) =>
  h("span", { class: "badge " + (p === "COMPLETED" ? "good" : p === "FAILED" ? "bad" : "accent") }, PHASE_LABEL[p] || p);

// ─── 데이터 로드 ────────────────────────────────────────────────
async function refreshList() {
  ui.runs = await getJson("/api/runs");
  const nav = document.getElementById("run-list");
  nav.replaceChildren(
    ...(ui.runs.length
      ? ui.runs.map((r) =>
          h(
            "a",
            { class: "run-link", href: "#/run/" + encodeURIComponent(r.runId), "aria-current": r.runId === ui.runId ? "page" : null },
            h("span", { class: "run-link-topic", title: r.topic }, r.topic),
            h("span", { class: "run-link-meta" }, phaseBadge(r.phase), time(r.createdAt)),
          ),
        )
      : [h("p", { class: "muted" }, "아직 실행이 없습니다.")]),
  );
}

async function loadRun(runId, { quiet = false } = {}) {
  try {
    const bundle = await getJson("/api/runs/" + encodeURIComponent(runId));
    const json = JSON.stringify(bundle);
    if (quiet && json === ui.bundleJson) return; // 변화 없으면 다시 그리지 않음
    ui.bundle = bundle;
    ui.bundleJson = json;
    render();
  } catch (err) {
    if (!quiet) document.getElementById("main").replaceChildren(h("div", { class: "banner bad" }, "불러오지 못했습니다: " + err.message));
  }
}

function schedule() {
  clearInterval(ui.timer);
  ui.timer = setInterval(async () => {
    if (document.hidden) return;
    await refreshList().catch(() => {});
    const p = ui.bundle && ui.bundle.state.phase;
    if (ui.runId && p !== "COMPLETED") await loadRun(ui.runId, { quiet: true });
  }, POLL_MS);
}

async function route() {
  const m = /^#\/run\/(.+)$/.exec(location.hash);
  if (!m) {
    if (ui.runs.length) location.replace("#/run/" + encodeURIComponent(ui.runs[0].runId));
    else renderEmpty();
    return;
  }
  const id = decodeURIComponent(m[1]);
  if (id !== ui.runId) {
    ui.runId = id;
    ui.bundle = null;
    ui.bundleJson = "";
    ui.open.clear();
    ui.version = {};
    await refreshList();
  }
  await loadRun(id);
}

// ─── 렌더링 ─────────────────────────────────────────────────────
function renderEmpty() {
  document.getElementById("main").replaceChildren(
    h("div", { class: "empty" },
      h("p", null, "연구 실행이 없습니다."),
      h("p", null, h("code", null, 'npm run arena -- create --topic "<주제>"'), " 로 시작하세요.")),
  );
}

function render() {
  const b = ui.bundle;
  const s = b.state;
  const main = document.getElementById("main");
  main.replaceChildren(
    renderHead(b),
    renderStepper(s),
    s.error ? h("div", { class: "banner bad", role: "alert" }, `[${s.error.phase}] ${s.error.message}`) : null,
    b.warnings.length ? h("div", { class: "banner warn" }, b.warnings.join(" · ")) : null,
    s.phase !== "COMPLETED" ? renderProgress(b) : null,
    renderScores(b),
    renderMetrics(b),
    renderEvents(b),
  );
}

function renderHead(b) {
  const s = b.state;
  return h("section", { class: "run-head" },
    h("h1", null, s.topic),
    s.constraints.length ? h("div", { class: "chips" }, s.constraints.map((c) => h("span", { class: "chip" }, c))) : null,
    h("div", { class: "run-meta" },
      phaseBadge(s.phase),
      h("span", { class: "mono" }, s.runId),
      h("span", null, "생성 " + time(s.createdAt)),
      s.completedAt ? h("span", null, "완료 " + time(s.completedAt)) : h("span", null, "갱신 " + time(s.updatedAt)),
      b.hasReport ? h("a", { href: `/api/runs/${encodeURIComponent(s.runId)}/report`, target: "_blank", rel: "noopener" }, "보고서 원문(report.md)") : null),
  );
}

function renderStepper(s) {
  const phases = ui.meta.phases;
  const current = s.phase === "FAILED" ? s.error && s.error.phase : s.phase;
  const idx = phases.indexOf(current);
  return h("ol", { class: "stepper", "aria-label": "진행 단계" },
    phases.map((p, i) => {
      let cls = "step";
      if (s.phase === "COMPLETED" || i < idx) cls += " done";
      else if (i === idx) cls += s.phase === "FAILED" ? " failed" : " current";
      // 토론 없이 지나간 경우 표시
      const skipped = p === "DEBATING" && i < idx && !ui.bundle.debate.agenda;
      return h("li", { class: cls, "aria-current": i === idx ? "step" : null, title: skipped ? "평가가 일치해 토론 생략" : null },
        skipped ? "토론 생략" : PHASE_LABEL[p]);
    }),
  );
}

function renderProgress(b) {
  const s = b.state;
  const waiting = b.expected.filter((f) => !f.exists).length;
  return h("section", { class: "section" },
    h("h2", { class: "section-title" }, "진행 상황"),
    h("div", { class: "card" },
      b.expected.length
        ? [
            h("p", { class: "muted" }, waiting ? `이 단계에서 ${b.expected.length}개 중 ${waiting}개 파일을 기다리는 중` : "필요한 파일이 모두 준비됨 — advance로 다음 단계로 진행하세요."),
            h("ul", { class: "file-list" },
              b.expected.map((f) =>
                h("li", null,
                  h("span", { class: "mark " + (f.exists ? "ok" : "no"), "aria-label": f.exists ? "완료" : "대기" }, f.exists ? "✓" : "·"),
                  h("span", { class: "mono" }, f.path),
                  h("span", { class: "muted" }, f.owner === "orchestrator" ? "오케스트레이터" : agent(f.owner))))),
          ]
        : h("p", { class: "muted" }, s.phase === "FAILED" ? "원인을 확인한 뒤 retry로 재개하세요." : "에이전트 작업이 없는 단계입니다."),
      h("div", { class: "cmd" }, `npm run arena -- ${s.phase === "FAILED" ? "retry" : "advance"} --run ${s.runId}`)),
  );
}

// 아이디어 정보 조회 헬퍼
function ideaOf(b, id, version) {
  const pool = version === 2 ? b.ideas.v2 : b.ideas.v1;
  return pool.find((i) => i.ideaId === id) || null;
}
function latestIdea(b, id) {
  return ideaOf(b, id, 2) || ideaOf(b, id, 1);
}
function evalOf(b, round, judge, id) {
  const f = b.evaluations["round" + round][judge];
  return f && Array.isArray(f.evaluations) ? f.evaluations.find((e) => e.ideaId === id) || null : null;
}

function renderScores(b) {
  const r = b.ranking;
  const agg = b.aggregates.round2 || b.aggregates.round1;
  if (!r && !agg) {
    if (!b.ideas.v1.length) return null;
    // 익명화 직후: 아이디어 목록만
    return h("section", { class: "section" },
      h("h2", { class: "section-title" }, "익명 아이디어"),
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, h("th", null, "ID"), h("th", null, "아이디어"), h("th", null, "핵심 사용자"))),
        h("tbody", null, b.ideas.v1.flatMap((i) => ideaRows(b, i.ideaId, 3,
          [h("td", { class: "idea-id" }, i.ideaId), h("td", { class: "idea-title" }, i.title), h("td", null, i.targetUsers)]))))));
  }

  if (r) {
    const cols = 6;
    return h("section", { class: "section" },
      h("h2", { class: "section-title" }, "최종 순위"),
      h("p", { class: "muted" }, "행을 누르면 원본·개선본, 심사 근거, 토론, MVP 계획을 볼 수 있습니다. 막대의 세로선은 최초 점수."),
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null,
          h("th", { class: "num" }, "순위"), h("th", null, "아이디어"), h("th", null, "생성 관점"),
          h("th", null, "점수 흐름 (최초 → 토론 후 → 최종)"), h("th", { class: "num" }, "변화"), h("th", { class: "num" }, "심사 격차"))),
        h("tbody", null, r.ranking.flatMap((x) => ideaRows(b, x.ideaId, cols, [
          h("td", { class: "num rank" }, x.rank),
          h("td", null, h("div", { class: "idea-title" }, x.title), h("div", { class: "idea-id" }, x.ideaId + (x.debated ? " · 토론" : ""))),
          h("td", null, agent(x.generatorId)),
          h("td", { class: "flow" },
            h("div", { class: "flow-track" },
              h("div", { class: "flow-fill", vars: { "--w": x.finalScore + "%" } }),
              h("div", { class: "flow-mark", vars: { "--x": x.initialScore + "%" } })),
            h("div", { class: "flow-text" }, `${fmt(x.initialScore)} → ${fmt(x.postDebateScore)} → ${fmt(x.finalScore)}`)),
          h("td", { class: "num " + (x.delta > 0 ? "delta-up" : x.delta < 0 ? "delta-down" : "") }, signed(x.delta)),
          h("td", { class: "num" }, fmt(x.finalGap), x.persistentDisagreement ? h("span", { class: "badge warn", title: "재평가 후에도 의견이 갈림" }, " 이견") : null),
        ]))))));
  }

  // 진행 중: 최신 집계
  const judges = ui.meta.judges;
  const cols = 4 + judges.length;
  const debated = new Set(b.aggregates.round1 ? b.aggregates.round1.disagreements : []);
  return h("section", { class: "section" },
    h("h2", { class: "section-title" }, (b.aggregates.round2 ? "재평가" : "1차 심사") + " 점수"),
    h("p", { class: "muted" }, "작성자는 연구가 완료된 뒤 공개됩니다. 행을 누르면 상세가 열립니다."),
    h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null,
        h("th", null, "아이디어"), judges.map((j) => h("th", { class: "num" }, agent(j))),
        h("th", { class: "num" }, "평균"), h("th", { class: "num" }, "격차"), h("th", null, "상태"))),
      h("tbody", null, [...agg.ideas].sort((a, z) => z.score - a.score).flatMap((a) => {
        const idea = latestIdea(b, a.ideaId);
        return ideaRows(b, a.ideaId, cols, [
          h("td", null, h("div", { class: "idea-title" }, idea ? idea.title : a.ideaId), h("div", { class: "idea-id" }, a.ideaId)),
          judges.map((j) => { const js = a.judges.find((x) => x.judgeId === j); return h("td", { class: "num" }, js ? fmt(js.total) : "–"); }),
          h("td", { class: "num" }, h("strong", null, fmt(a.score))),
          h("td", { class: "num" }, fmt(a.totalGap)),
          h("td", null, debated.has(a.ideaId) ? h("span", { class: "badge warn" }, "토론 대상") : h("span", { class: "badge" }, "일치")),
        ]);
      })))));
}

/** 요약 행 + (펼쳐졌으면) 상세 행 */
function ideaRows(b, id, colspan, cells) {
  const isOpen = ui.open.has(id);
  const toggle = () => {
    if (ui.open.has(id)) ui.open.delete(id);
    else ui.open.add(id);
    render();
  };
  const row = h("tr", {
    class: "row-click", tabindex: "0", "aria-expanded": String(isOpen),
    onclick: toggle,
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } },
  }, cells);
  if (!isOpen) return [row];
  return [row, h("tr", null, h("td", { class: "detail-cell", colspan }, renderDetail(b, id)))];
}

function renderDetail(b, id) {
  const hasV2 = !!ideaOf(b, id, 2);
  const v = ui.version[id] || (hasV2 ? 2 : 1);
  const idea = ideaOf(b, id, v);
  const setV = (n) => (e) => { e.stopPropagation(); ui.version[id] = n; render(); };

  return h("div", { class: "detail" },
    hasV2 ? h("div", { class: "seg", role: "group", "aria-label": "버전" },
      h("button", { type: "button", "aria-pressed": String(v === 1), onclick: setV(1) }, "원본 v1"),
      h("button", { type: "button", "aria-pressed": String(v === 2), onclick: setV(2) }, "개선본 v2")) : null,
    idea ? renderIdeaFields(idea) : h("p", { class: "muted" }, "아이디어 파일을 읽을 수 없습니다."),
    renderScoreMatrix(b, id),
    renderJudgeNotes(b, id),
    renderDebate(b, id),
    v === 2 && idea ? renderRevision(idea) : null,
  );
}

function renderIdeaFields(i) {
  return h("div", null,
    h("h4", null, `${i.title} · v${i.version}`),
    h("dl", { class: "fields" },
      h("dt", null, "문제"), h("dd", null, i.problem),
      h("dt", null, "핵심 사용자"), h("dd", null, i.targetUsers),
      h("dt", null, "해결 방식"), h("dd", null, i.solution),
      h("dt", null, "차별성"), h("dd", null, i.differentiation),
      h("dt", null, "MVP 기능"), h("dd", null, list(i.mvp)),
      h("dt", null, "미검증 가정"), h("dd", null, list(i.assumptions))));
}

function renderScoreMatrix(b, id) {
  const judges = ui.meta.judges;
  const post = b.debate.resolution && b.debate.resolution.postDebate.ideas.find((x) => x.ideaId === id);
  const rounds = [1, 2].filter((r) => judges.some((j) => evalOf(b, r, j, id)));
  if (!rounds.length) return null;

  const head = [h("th", null, "항목")];
  for (const j of judges) {
    head.push(h("th", { class: "num" }, agent(j) + " 1차"));
    if (post) head.push(h("th", { class: "num" }, "토론 후"));
    if (rounds.includes(2)) head.push(h("th", { class: "num" }, "재평가"));
  }
  const rows = ui.meta.criteria.map((c) => {
    const cells = [h("td", null, c.label)];
    for (const j of judges) {
      const e1 = evalOf(b, 1, j, id);
      const s1 = e1 ? e1.scores[c.id] : null;
      cells.push(h("td", { class: "num", title: s1 ? s1.rationale : null }, s1 ? s1.score : "–"));
      if (post) {
        const pj = post.judges.find((x) => x.judgeId === j);
        const pv = pj ? pj.scores[c.id] : null;
        cells.push(h("td", { class: "num" + (s1 && pv !== s1.score ? " score-cell-changed" : "") }, pv === null || pv === undefined ? "–" : pv));
      }
      if (rounds.includes(2)) {
        const e2 = evalOf(b, 2, j, id);
        const s2 = e2 ? e2.scores[c.id] : null;
        cells.push(h("td", { class: "num", title: s2 ? s2.rationale : null }, s2 ? s2.score : "–"));
      }
    }
    return h("tr", null, cells);
  });
  return h("div", null,
    h("h4", null, "심사 점수 (0~5, 셀에 마우스를 올리면 근거)"),
    h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, head)), h("tbody", null, rows))));
}

function renderJudgeNotes(b, id) {
  const round = ui.meta.judges.some((j) => evalOf(b, 2, j, id)) ? 2 : 1;
  const notes = ui.meta.judges.map((j) => ({ j, e: evalOf(b, round, j, id) })).filter((x) => x.e);
  if (!notes.length) return null;
  return h("div", null,
    h("h4", null, round === 2 ? "재평가 의견" : "1차 심사 의견"),
    h("div", { class: "two-col" }, notes.map(({ j, e }) =>
      h("div", { class: "judge-note" },
        h("strong", null, agent(j)),
        h("div", null, e.summary),
        e.changeFromPrevious ? [h("span", { class: "label" }, "1차 대비 변화"), h("div", null, e.changeFromPrevious)] : null,
        h("span", { class: "label" }, "강점"), list(e.strengths),
        h("span", { class: "label" }, "약점"), list(e.weaknesses),
        h("span", { class: "label" }, "실패 가능성"), list(e.risks),
        e.criticalIssues && e.criticalIssues.length ? [h("span", { class: "label" }, "중대 이슈"), list(e.criticalIssues)] : null,
        h("span", { class: "label" }, "검증할 가설"), list(e.hypotheses)))));
}

function renderDebate(b, id) {
  const entries = ui.meta.judges
    .map((j) => { const f = b.debate.entries[j]; return { j, e: f && f.entries ? f.entries.find((x) => x.ideaId === id) : null }; })
    .filter((x) => x.e);
  const target = b.debate.agenda && b.debate.agenda.targets.find((t) => t.ideaId === id);
  if (!entries.length && !target) return null;
  return h("div", null,
    h("h4", null, "교차 토론" + (target ? ` (1차 격차 ${fmt(target.totalGap)})` : "")),
    entries.length
      ? h("div", { class: "two-col" }, entries.map(({ j, e }) =>
          h("div", { class: "debate-entry" },
            h("header", null, h("strong", null, agent(j)),
              h("span", { class: "badge " + (e.stance === "MAINTAIN" ? "" : "accent") }, e.stance === "MAINTAIN" ? "입장 유지" : "점수 수정")),
            h("p", null, e.position),
            h("p", { class: "muted" }, "반박: ", e.rebuttal),
            (e.concessions || []).map((c) => h("p", { class: "muted" }, "인정: ", c)),
            (e.scoreChanges || []).map((sc) =>
              h("div", { class: "change" },
                `${(ui.meta.criteria.find((c) => c.id === sc.criterion) || {}).label || sc.criterion} ${sc.from}→${sc.to} `,
                h("span", { class: "badge" + (sc.basis === "PEER_PERSUASION" ? " warn" : "") }, ui.meta.bases[sc.basis] || sc.basis),
                " ", sc.rationale)))))
      : h("p", { class: "muted" }, "심사위원 토론 작성 대기 중"));
}

function renderRevision(i) {
  return h("div", { class: "two-col" },
    h("div", null,
      h("h4", null, "개선 내역"),
      list((i.changelog || []).map((c) => `${c.change} ← ${c.addresses}`)),
      i.rejectedFeedback && i.rejectedFeedback.length
        ? [h("h4", { class: "section" }, "수용하지 않은 피드백"), list(i.rejectedFeedback.map((r) => `“${r.feedback}” — ${r.reason}`))]
        : null),
    h("div", null,
      h("h4", null, "MVP 개발 계획"),
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, h("th", { class: "num" }, "주차"), h("th", null, "목표"), h("th", null, "산출물"))),
        h("tbody", null, [...(i.mvpPlan || [])].sort((a, z) => a.week - z.week).map((s) =>
          h("tr", null, h("td", { class: "num" }, s.week), h("td", null, s.goal), h("td", null, s.deliverables.join(", ")))))))));
}

function renderMetrics(b) {
  const stat = (label, value) => h("div", { class: "stat" }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value" }, value));
  const items = [];
  const r = b.ranking;
  const res = b.debate.resolution;
  if (r) {
    const m = r.metrics;
    items.push(stat("평균 점수 최초 → 최종", `${fmt(m.meanInitialScore)} → ${fmt(m.meanFinalScore)} (${signed(m.meanDelta)})`));
    items.push(stat("심사 격차 1차 → 토론 후 → 재평가", `${fmt(m.judgeGap.round1)} → ${fmt(m.judgeGap.postDebate)} → ${fmt(m.judgeGap.round2)}`));
    items.push(stat("토론 대상", m.debateTargets.length ? m.debateTargets.join(", ") : "없음 (평가 일치)"));
    items.push(stat("토론 입장 (유지 / 수정)", `${m.stances.maintain} / ${m.stances.revise}`));
    for (const [basis, n] of Object.entries(m.scoreChangesByBasis)) items.push(stat("점수 변경 · " + (ui.meta.bases[basis] || basis), n + "건"));
    for (const g of m.byGenerator) items.push(stat(agent(g.generatorId) + " 평균 / 최고 순위", `${fmt(g.meanFinalScore)} / ${g.bestRank}위`));
  } else if (res) {
    items.push(stat("심사 격차 1차 → 토론 후", `${fmt(res.meanTotalGapBefore)} → ${fmt(res.meanTotalGapAfter)}`));
    for (const [basis, n] of Object.entries(res.basisCounts)) items.push(stat("점수 변경 · " + (ui.meta.bases[basis] || basis), n + "건"));
    items.push(stat("토론 후에도 이견", res.unresolved.length ? res.unresolved.join(", ") : "없음"));
  } else if (b.aggregates.round1) {
    items.push(stat("1차 심사 평균 격차", fmt(b.aggregates.round1.meanTotalGap)));
    items.push(stat("토론 대상", b.aggregates.round1.disagreements.length + "개"));
  }
  if (!items.length) return null;
  return h("section", { class: "section" }, h("h2", { class: "section-title" }, "오케스트레이션 지표"), h("div", { class: "stats" }, items));
}

function renderEvents(b) {
  if (!b.events.length) return null;
  const describe = (e) => {
    if (e.type === "PHASE_TRANSITION") return `${PHASE_LABEL[e.from] || e.from} → ${PHASE_LABEL[e.to] || e.to}`;
    if (e.type === "ADVANCE_BLOCKED") return `전이 중단: ${(e.details || []).length}개 문제`;
    return e.message || "";
  };
  return h("section", { class: "section" },
    h("h2", { class: "section-title" }, "실행 기록"),
    h("div", { class: "card" }, h("ul", { class: "events" },
      [...b.events].reverse().map((e) =>
        h("li", null, h("time", { datetime: e.ts }, time(e.ts)), h("span", null, e.type), h("span", null, describe(e)))))));
}

// ─── 시작 ───────────────────────────────────────────────────────
(async function init() {
  try {
    ui.meta = await getJson("/api/meta");
    await refreshList();
    window.addEventListener("hashchange", route);
    await route();
    schedule();
  } catch (err) {
    document.getElementById("main").replaceChildren(h("div", { class: "banner bad" }, "대시보드 서버에 연결할 수 없습니다: " + err.message));
  }
})();
