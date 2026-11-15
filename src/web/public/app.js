// IDEA ARENA 웹 앱. 에이전트가 쓴 텍스트는 모두 textContent로만 넣는다(innerHTML 금지).
//
// 실행 데이터(실행 디렉터리의 파일 묶음)는 이 브라우저의 IndexedDB에 저장한다. 서버에는 DB가 없다.
// 진행 순서(Team Lead 프로토콜과 같음): 단계 담당 에이전트 병렬 작업 → advance(검증·전이)
//   → 전이 중단이면 오류가 난 에이전트에게만 오류를 전달해 다시 쓰게 한다(최대 2회).
"use strict";

const MAX_BLOCKED_ROUNDS = 2;
const ui = {
  meta: null,
  session: null, // { authenticated, setup, models }
  records: new Map(), // runId → { runId, topic, phase, createdAt, updatedAt, files, bundle }
  view: "run", // "run" | "new"
  runId: null,
  open: new Set(), // 펼친 아이디어
  version: {}, // ideaId → 1 | 2
  busy: null, // { runId, note, agents: Map<agent, { since, state }> }
  stopRequested: false,
  errors: {}, // runId → 메시지
  notice: "",
  labels: null, // 지금 보고 있는 실행의 상황 프리셋 이름표(bundle.labels)
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
const agent = (id) => (ui.labels && ui.labels.agents[id]) || (ui.meta && ui.meta.agents[id]) || id;
const criteria = () => (ui.labels || ui.meta).criteria;
const FIELD_DEFAULTS = { problem: "문제", targetUsers: "핵심 사용자", solution: "해결 방식", differentiation: "차별성", mvp: "MVP 기능", assumptions: "미검증 가정", plan: "MVP 개발 계획" };
const field = (k) => (ui.labels && ui.labels.fields[k]) || FIELD_DEFAULTS[k];
const list = (items, empty = "없음") =>
  items && items.length ? h("ul", { class: "plain-list" }, items.map((s) => h("li", null, s))) : h("span", { class: "muted" }, empty);
const $main = () => document.getElementById("main");

const PHASE_LABEL = {
  CREATED: "생성됨", GENERATING: "아이디어 생성", BLINDING: "익명화", SCORING: "1차 심사", DEBATING: "토론",
  REVISING: "개선", RESCORING: "재평가", FINALIZING: "최종 집계", COMPLETED: "완료", FAILED: "실패",
};
const phaseBadge = (p) =>
  h("span", { class: "badge " + (p === "COMPLETED" ? "good" : p === "FAILED" ? "bad" : "accent") }, PHASE_LABEL[p] || p);

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── 서버 API ───────────────────────────────────────────────────
class AuthError extends Error {}

async function api(action, payload) {
  const res = await fetch("/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ action, ...payload }),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* 함수 시간 초과 등으로 JSON이 아닌 응답 */
  }
  if (res.status === 401 && action !== "login") {
    ui.session = { ...(ui.session || {}), authenticated: false };
    throw new AuthError(body.error || "로그인이 필요합니다");
  }
  if (!res.ok) {
    const fallback = res.status === 504 ? "서버 함수 시간 제한(300초)을 넘었습니다. '이어서 진행'을 누르면 그 작업부터 다시 합니다." : `요청 실패 (HTTP ${res.status})`;
    throw new Error(body.error || fallback);
  }
  return body;
}

async function loadSession() {
  const res = await fetch("/api?action=session", { cache: "no-store", credentials: "same-origin" });
  const body = await res.json();
  ui.meta = body.meta;
  ui.session = body;
}

// ─── 브라우저 저장소 (IndexedDB) ─────────────────────────────────
const store = {
  db: null,
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("idea-arena", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("runs", { keyPath: "runId" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction("runs", mode);
      const req = fn(t.objectStore("runs"));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },
  all() { return this.tx("readonly", (s) => s.getAll()); },
  put(rec) { return this.tx("readwrite", (s) => s.put(rec)); },
  del(runId) { return this.tx("readwrite", (s) => s.delete(runId)); },
};

/** 메모리 사본을 먼저 고치고(동기) 저장한다 — 병렬 에이전트 결과가 서로 덮어쓰지 않는다. */
async function saveRecord(runId, mutate) {
  const prev = ui.records.get(runId);
  const rec = prev ? { ...prev, files: { ...prev.files } } : { runId, files: {} };
  mutate(rec);
  if (rec.bundle) {
    const s = rec.bundle.state;
    Object.assign(rec, { topic: s.topic, phase: s.phase, createdAt: s.createdAt, updatedAt: s.updatedAt });
  }
  ui.records.set(runId, rec);
  try {
    await store.put(rec);
  } catch (err) {
    ui.notice = "브라우저 저장소에 저장하지 못했습니다(" + err.message + "). 실행을 내보내기로 백업하세요.";
  }
  return rec;
}

const sortedRuns = () => [...ui.records.values()].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

// ─── 자동 진행 ──────────────────────────────────────────────────
function setNote(note) {
  if (!ui.busy) return;
  ui.busy.note = note;
  render();
}

async function runAgent(runId, owner, hint) {
  ui.busy.agents.set(owner, { since: Date.now(), state: "working" });
  render();
  try {
    const rec = ui.records.get(runId);
    const out = await api("agent", { runId, files: rec.files, agent: owner, hint });
    if (out.file) await saveRecord(runId, (r) => { r.files[out.file.path] = out.file.content; });
    ui.busy.agents.set(owner, { since: Date.now(), state: out.result.ok ? "done" : "invalid" });
  } catch (err) {
    ui.busy.agents.set(owner, { since: Date.now(), state: "error" });
    throw err;
  } finally {
    render();
  }
}

async function drive(runId, { retry = false } = {}) {
  if (ui.busy) return;
  ui.busy = { runId, note: "", agents: new Map() };
  ui.stopRequested = false;
  delete ui.errors[runId];
  render();
  try {
    if (retry) {
      setNote("실패한 단계부터 다시 시도하는 중");
      const out = await api("retry", { runId, files: ui.records.get(runId).files });
      await saveRecord(runId, (r) => { r.files = out.files; r.bundle = out.bundle; });
      if (out.outcome.status === "failed") return;
    }
    let blocked = 0;
    let hints = {};
    for (;;) {
      const rec = ui.records.get(runId);
      const phase = rec.bundle.state.phase;
      if (phase === "COMPLETED" || phase === "FAILED" || ui.stopRequested) break;

      // 이 단계 담당 에이전트 중 아직 파일이 없거나, 전이 중단으로 고쳐야 하는 에이전트만 작업
      const pending = rec.bundle.expected.filter((f) => f.owner !== "orchestrator" && (!(f.path in rec.files) || hints[f.owner]));
      if (pending.length) {
        ui.busy.agents = new Map();
        setNote(`${PHASE_LABEL[phase]} — 에이전트 ${pending.length}명 작업 중`);
        const settled = await Promise.allSettled(pending.map((f) => runAgent(runId, f.owner, hints[f.owner])));
        hints = {};
        const failed = settled.find((s) => s.status === "rejected");
        if (failed) throw failed.reason;
      }
      if (ui.stopRequested) break;

      setNote("검증하고 다음 단계로 넘어가는 중");
      const out = await api("advance", { runId, files: ui.records.get(runId).files });
      await saveRecord(runId, (r) => { r.files = out.files; r.bundle = out.bundle; });
      if (out.outcome.status === "failed") break;
      if (out.outcome.status !== "blocked") {
        blocked = 0;
        continue;
      }
      // 전이 중단: 오류가 난 파일의 담당 에이전트에게만 오류를 전달해 다시 쓰게 한다
      for (const f of out.bundle.expected) {
        const errs = out.outcome.errors.filter((e) => f.owner !== "orchestrator" && e.includes(f.path));
        if (errs.length) hints[f.owner] = errs;
      }
      if (++blocked > MAX_BLOCKED_ROUNDS || !Object.keys(hints).length) {
        ui.errors[runId] = "검증을 통과하지 못해 멈췄습니다: " + out.outcome.errors.slice(0, 5).join(" / ");
        break;
      }
    }
  } catch (err) {
    ui.errors[runId] = err.message;
  } finally {
    ui.busy = null;
    await refreshSidebar();
    render();
  }
}

// ─── 화면 동작 ──────────────────────────────────────────────────
async function startRun(topic, constraints, preset) {
  const out = await api("create", { topic, constraints, preset });
  await saveRecord(out.runId, (r) => { r.files = out.files; r.bundle = out.bundle; });
  location.hash = "#/run/" + encodeURIComponent(out.runId);
  drive(out.runId);
}

async function importRun(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("JSON 파일이 아닙니다");
  }
  if (!data || data.format !== "idea-arena-run" || typeof data.runId !== "string" || !data.files) {
    throw new Error("IDEA ARENA 실행 내보내기 파일이 아닙니다");
  }
  if (ui.records.has(data.runId) && !confirm(`이미 있는 실행(${data.runId})을 가져온 파일로 바꿉니다. 계속할까요?`)) return;
  const out = await api("view", { runId: data.runId, files: data.files });
  await saveRecord(data.runId, (r) => { r.files = data.files; r.bundle = out.bundle; });
  location.hash = "#/run/" + encodeURIComponent(data.runId);
}

function exportRun(rec) {
  download(`idea-arena-${rec.runId}.json`, JSON.stringify({ format: "idea-arena-run", version: 1, runId: rec.runId, files: rec.files }), "application/json");
}

async function deleteRun(rec) {
  if (!confirm(`"${rec.topic}" 실행을 이 브라우저에서 삭제합니다. 내보내기로 백업하지 않았다면 되돌릴 수 없습니다.`)) return;
  await store.del(rec.runId);
  ui.records.delete(rec.runId);
  location.hash = "#/";
}

// ─── 라우팅 ─────────────────────────────────────────────────────
async function route() {
  if (!ui.session || !ui.session.authenticated) return render();
  if (location.hash === "#/new") {
    ui.view = "new";
    ui.runId = null;
  } else {
    const m = /^#\/run\/(.+)$/.exec(location.hash);
    if (!m) {
      const first = sortedRuns()[0];
      if (first) return location.replace("#/run/" + encodeURIComponent(first.runId));
      return location.replace("#/new");
    }
    const id = decodeURIComponent(m[1]);
    if (id !== ui.runId) {
      ui.open.clear();
      ui.version = {};
    }
    ui.view = "run";
    ui.runId = id;
  }
  await refreshSidebar();
  render();
}

// ─── 렌더링: 틀 ─────────────────────────────────────────────────
function refreshSidebar() {
  const nav = document.getElementById("run-list");
  const authed = ui.session && ui.session.authenticated;
  document.getElementById("topbar-actions").replaceChildren(
    ...(authed
      ? [
          h("a", { class: "btn", href: "#/new" }, "새 연구"),
          h("label", { class: "btn" }, "가져오기",
            h("input", { type: "file", accept: "application/json,.json", class: "visually-hidden", onchange: async (e) => {
              const file = e.target.files[0];
              e.target.value = "";
              if (!file) return;
              try { await importRun(file); } catch (err) { ui.notice = "가져오지 못했습니다: " + err.message; render(); }
            } })),
          h("button", { type: "button", class: "btn ghost", onclick: async () => {
            await api("logout", {}).catch(() => {});
            ui.session = { ...ui.session, authenticated: false };
            render();
          } }, "로그아웃"),
        ]
      : []),
  );
  document.querySelector(".sidebar").hidden = !authed;
  if (!authed) return;
  const runs = sortedRuns();
  nav.replaceChildren(
    ...(runs.length
      ? runs.map((r) =>
          h("a", { class: "run-link", href: "#/run/" + encodeURIComponent(r.runId), "aria-current": r.runId === ui.runId ? "page" : null },
            h("span", { class: "run-link-topic", title: r.topic }, r.topic),
            h("span", { class: "run-link-meta" }, phaseBadge(r.phase), r.createdAt ? time(r.createdAt) : "")))
      : [h("p", { class: "muted" }, "아직 실행이 없습니다.")]),
  );
}

function render() {
  refreshSidebar();
  const main = $main();
  const notice = ui.notice ? h("div", { class: "banner warn", role: "status" }, ui.notice, " ",
    h("button", { type: "button", class: "link", onclick: () => { ui.notice = ""; render(); } }, "닫기")) : null;
  // 입력 중인 폼은 다시 그리지 않는다(진행 중인 실행의 상태 변화로 입력이 지워지지 않게)
  const shown = main.firstElementChild && main.querySelector("[data-view]");
  const want = !ui.session || !ui.session.authenticated ? "login" : ui.view === "new" ? "new" : null;
  if (want && shown && shown.getAttribute("data-view") === want && !notice) return;
  if (want === "login") return main.replaceChildren(renderLogin());
  if (want === "new") return main.replaceChildren(notice || "", renderNewRun());
  const rec = ui.records.get(ui.runId);
  if (!rec || !rec.bundle) {
    return main.replaceChildren(notice || "", h("div", { class: "empty" }, h("p", null, "이 브라우저에 저장된 실행이 아닙니다."), h("a", { href: "#/new" }, "새 연구 시작")));
  }
  ui.labels = rec.bundle.labels || null;
  main.replaceChildren(notice || "", ...renderRun(rec));
}

function renderLogin() {
  const setup = (ui.session && ui.session.setup) || {};
  const error = h("p", { class: "field-error", role: "alert", id: "login-error" });
  const input = h("input", { id: "password", type: "password", name: "password", autocomplete: "current-password", required: true, "aria-describedby": "login-error" });
  const button = h("button", { type: "submit", class: "btn primary" }, "로그인");
  const form = h("form", { class: "card form narrow", "data-view": "login", onsubmit: async (e) => {
    e.preventDefault();
    button.disabled = true;
    error.textContent = "";
    try {
      await api("login", { password: input.value });
      await loadSession();
      await route();
    } catch (err) {
      error.textContent = err.message;
      input.select();
    } finally {
      button.disabled = false;
    }
  } },
    h("h1", null, "IDEA ARENA"),
    h("p", { class: "muted" }, "비밀번호를 입력해야 사용할 수 있습니다."),
    !setup.password ? h("div", { class: "banner bad" }, "서버에 APP_PASSWORD 환경 변수가 설정되지 않아 로그인할 수 없습니다.") : null,
    h("label", { for: "password" }, "비밀번호"),
    input,
    error,
    button);
  queueMicrotask(() => input.focus());
  return form;
}

function renderNewRun() {
  const setup = ui.session.setup || {};
  const models = ui.session.models;
  const error = h("p", { class: "field-error", role: "alert", id: "new-error" });
  const topic = h("textarea", { id: "topic", rows: "4", maxlength: "4000", required: true, placeholder: "예: 동아리 신입 회원이 1년 넘게 남게 하는 방법" });
  const constraints = h("textarea", { id: "constraints", rows: "3", placeholder: "예: 2~3명 팀\n4주 안에 결과물\n예산 50만 원" });
  const presets = ui.meta.presets || [];
  const presetHelp = h("p", { class: "muted field-help", id: "preset-help" });
  const preset = h("select", { id: "preset", "aria-describedby": "preset-help", onchange: () => {
    const p = presets.find((x) => x.id === preset.value);
    presetHelp.textContent = p ? p.description : "";
  } }, presets.map((p) => h("option", { value: p.id, selected: p.id === ui.meta.defaultPreset }, p.name)));
  presetHelp.textContent = (presets.find((x) => x.id === ui.meta.defaultPreset) || {}).description || "";
  const button = h("button", { type: "submit", class: "btn primary", disabled: !setup.llm }, "연구 시작");
  const form = h("form", { class: "card form", "data-view": "new", onsubmit: async (e) => {
    e.preventDefault();
    if (!topic.value.trim()) {
      error.textContent = "주제를 입력하세요.";
      topic.focus();
      return;
    }
    button.disabled = true;
    error.textContent = "";
    try {
      await startRun(topic.value.trim(), constraints.value.split("\n").map((s) => s.trim()).filter(Boolean), preset.value);
    } catch (err) {
      error.textContent = "시작하지 못했습니다: " + err.message;
      button.disabled = false;
    }
  } },
    h("h1", null, "새 연구"),
    h("p", { class: "muted" }, "생성자 3명이 아이디어 2개씩 독립 생성 → 심사위원 2명이 익명 채점 → 의견이 갈린 아이디어만 토론 → 개선 → 재평가 → TOP 3 보고서. 상황에 따라 생성 관점·심사위원·평가 기준이 바뀝니다. 보통 5~15분 걸리고, 진행 중에는 이 탭을 열어 두세요."),
    !setup.llm ? h("div", { class: "banner bad" }, "서버에 LETSUR_API_KEY 환경 변수가 설정되지 않아 실행할 수 없습니다.") : null,
    h("label", { for: "preset" }, "상황"),
    preset,
    presetHelp,
    h("label", { for: "topic" }, "주제"),
    topic,
    h("label", { for: "constraints" }, "제약 ", h("span", { class: "muted" }, "(한 줄에 하나, 선택)")),
    constraints,
    error,
    h("div", { class: "form-row" }, button, models ? h("span", { class: "muted" }, `모델: 생성자 ${models.generator} · 심사위원 ${models.judge}`) : null));
  queueMicrotask(() => topic.focus());
  return form;
}

function renderRun(rec) {
  const b = rec.bundle;
  const s = b.state;
  return [
    renderHead(rec),
    renderStepper(s),
    s.error ? h("div", { class: "banner bad", role: "alert" }, `[${s.error.phase}] ${s.error.message}`) : null,
    ui.errors[rec.runId] ? h("div", { class: "banner bad", role: "alert" }, ui.errors[rec.runId]) : null,
    b.warnings.length ? h("div", { class: "banner warn" }, b.warnings.join(" · ")) : null,
    s.phase !== "COMPLETED" ? renderProgress(rec) : null,
    renderScores(b),
    renderMetrics(b),
    renderEvents(b),
  ].filter(Boolean);
}

function renderHead(rec) {
  const s = rec.bundle.state;
  const report = rec.files["final/report.md"];
  const busy = ui.busy && ui.busy.runId === rec.runId;
  return h("section", { class: "run-head" },
    h("h1", null, s.topic),
    s.constraints.length ? h("div", { class: "chips" }, s.constraints.map((c) => h("span", { class: "chip" }, c))) : null,
    h("div", { class: "run-meta" },
      phaseBadge(s.phase),
      rec.bundle.labels ? h("span", { class: "badge" }, rec.bundle.labels.presetName) : null,
      h("span", { class: "mono" }, s.runId),
      h("span", null, "생성 " + time(s.createdAt)),
      s.completedAt ? h("span", null, "완료 " + time(s.completedAt)) : h("span", null, "갱신 " + time(s.updatedAt))),
    h("div", { class: "form-row" },
      report ? h("button", { type: "button", class: "btn", onclick: () => download(`idea-arena-${s.runId}-report.md`, report, "text/markdown") }, "보고서 다운로드") : null,
      h("button", { type: "button", class: "btn", onclick: () => exportRun(rec) }, "실행 내보내기"),
      h("button", { type: "button", class: "btn danger", disabled: busy, onclick: () => deleteRun(rec) }, "실행 삭제")),
  );
}

function renderProgress(rec) {
  const b = rec.bundle;
  const s = b.state;
  const busy = ui.busy && ui.busy.runId === rec.runId ? ui.busy : null;
  const otherBusy = ui.busy && !busy;
  const STATE = {
    working: ["…", "작성 중"],
    done: ["✓", "완료"],
    invalid: ["!", "검증 실패"],
    error: ["×", "오류"],
  };
  const rows = b.expected.map((f) => {
    const a = busy && busy.agents.get(f.owner);
    const has = f.path in rec.files;
    const [mark, label] = a ? STATE[a.state] : has ? ["✓", "완료"] : ["·", "대기"];
    return h("li", null,
      h("span", { class: "mark " + (mark === "✓" ? "ok" : mark === "×" || mark === "!" ? "bad" : "no"), "aria-hidden": "true" }, mark),
      h("span", null, f.owner === "orchestrator" ? "오케스트레이터" : agent(f.owner)),
      h("span", { class: "muted" }, label),
      a && a.state === "working" ? h("span", { class: "muted mono", "data-since": String(a.since) }, "0초") : null);
  });

  let controls;
  if (busy) {
    controls = [
      h("span", { class: "muted" }, ui.stopRequested ? "지금 작업이 끝나면 멈춥니다" : busy.note),
      h("button", { type: "button", class: "btn", disabled: ui.stopRequested, onclick: () => { ui.stopRequested = true; render(); } }, "일시정지"),
    ];
  } else if (s.phase === "FAILED") {
    controls = [h("button", { type: "button", class: "btn primary", disabled: otherBusy, onclick: () => drive(rec.runId, { retry: true }) }, "실패 단계부터 재시도")];
  } else {
    controls = [
      h("button", { type: "button", class: "btn primary", disabled: otherBusy, onclick: () => drive(rec.runId) }, "이어서 진행"),
      otherBusy ? h("span", { class: "muted" }, "다른 실행이 진행 중입니다") : null,
    ];
  }

  return h("section", { class: "section" },
    h("h2", { class: "section-title" }, "진행 상황 · " + (PHASE_LABEL[s.phase] || s.phase)),
    h("div", { class: "card" },
      rows.length ? h("ul", { class: "file-list" }, rows) : h("p", { class: "muted" }, "에이전트 작업이 없는 단계입니다."),
      h("div", { class: "form-row" }, controls)),
  );
}

function renderStepper(s) {
  const phases = ui.meta.phases;
  const current = s.phase === "FAILED" ? s.error && s.error.phase : s.phase;
  const idx = phases.indexOf(current);
  const debated = !!ui.records.get(ui.runId).bundle.debate.agenda;
  return h("ol", { class: "stepper", "aria-label": "진행 단계" },
    phases.map((p, i) => {
      let cls = "step";
      if (s.phase === "COMPLETED" || i < idx) cls += " done";
      else if (i === idx) cls += s.phase === "FAILED" ? " failed" : " current";
      const skipped = p === "DEBATING" && i < idx && !debated; // 평가가 일치해 토론 없이 지나간 경우
      return h("li", { class: cls, "aria-current": i === idx ? "step" : null, title: skipped ? "평가가 일치해 토론 생략" : null },
        skipped ? "토론 생략" : PHASE_LABEL[p]);
    }),
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
      h("dt", null, field("problem")), h("dd", null, i.problem),
      h("dt", null, field("targetUsers")), h("dd", null, i.targetUsers),
      h("dt", null, field("solution")), h("dd", null, i.solution),
      h("dt", null, field("differentiation")), h("dd", null, i.differentiation),
      h("dt", null, field("mvp")), h("dd", null, list(i.mvp)),
      h("dt", null, field("assumptions")), h("dd", null, list(i.assumptions))));
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
  const rows = criteria().map((c) => {
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
                `${(criteria().find((c) => c.id === sc.criterion) || {}).label || sc.criterion} ${sc.from}→${sc.to} `,
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
      h("h4", null, field("plan")),
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, h("th", { class: "num" }, (ui.labels && ui.labels.planUnit) || "주차"), h("th", null, "목표"), h("th", null, "산출물"))),
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
// 작업 중인 에이전트의 경과 시간 표시(화면 전체를 다시 그리지 않음)
setInterval(() => {
  for (const el of document.querySelectorAll("[data-since]")) {
    const sec = Math.floor((Date.now() - Number(el.getAttribute("data-since"))) / 1000);
    el.textContent = sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${sec % 60}초`;
  }
}, 1000);

window.addEventListener("beforeunload", (e) => {
  if (ui.busy) e.preventDefault(); // 진행 중에 탭을 닫으면 지금 작업 결과를 잃는다
});

(async function init() {
  try {
    await loadSession();
  } catch (err) {
    $main().replaceChildren(h("div", { class: "banner bad" }, "서버에 연결할 수 없습니다: " + err.message));
    return;
  }
  try {
    await store.open();
    for (const rec of await store.all()) ui.records.set(rec.runId, rec);
  } catch (err) {
    ui.notice = "이 브라우저에서 저장소(IndexedDB)를 쓸 수 없어 새로고침하면 실행이 사라집니다. 결과는 내보내기로 백업하세요.";
    store.put = async () => {};
    store.del = async () => {};
  }
  window.addEventListener("hashchange", route);
  await route();
})();
