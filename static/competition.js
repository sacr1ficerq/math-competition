"use strict";

const $ = (id) => document.getElementById(id);
const render = window.renderMarkdown;
let state = null;
let code = location.pathname.match(/^\/s\/([^/]+)\/?$/)?.[1]?.toUpperCase() || null;
let clockOffset = 0;
let pollTimer;
let draftTimer;
let loadedDraft = false;
let draftDirty = false;
let draftConflict = false;
let draftRevision = 0;
let savePromise = null;
let actionBusy = false;
let pendingRequest = null;
let historySignature = "";
let chatSignature = "";
let problemSignature = "";
let playerSignature = "";
let roundHistorySignature = "";
let solutionImages;
let restoringImages = false;
let imageBackupFailed = false;

function requestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}

async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = typeof data.detail === "string" ? data.detail : data.detail?.map((e) => `${e.loc.slice(1).join(".")}: ${e.msg}`).join("; ");
    const error = new Error(message || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const me = () => state?.players.find((p) => p.id === state.me);
const sessionPath = (suffix = "") => `/api/sessions/${encodeURIComponent(code)}${suffix}`;
const timeText = (value) => new Date(value * 1000).toLocaleTimeString();
const now = () => Date.now() / 1000 + clockOffset;
const draftKey = () => `math-draft:${code}:${state.me}${state.round > 1 ? `:${state.round}` : ""}`;

function backupDraft() {
  try { localStorage.setItem(draftKey(), JSON.stringify({ text: $("solution").value, revision: draftRevision })); } catch { /* Server autosave still works without browser storage. */ }
}

function clearBackup() {
  try { localStorage.removeItem(draftKey()); } catch { /* Storage can be disabled. */ }
}

function preview() { render($("preview"), $("solution").value || "Здесь появится ваше решение."); }

function apply(next) {
  if (state && next.code === state.code && next.version < state.version) return;
  const previousPhase = state?.phase;
  const roundChanged = state && (next.code !== state.code || next.round !== state.round);
  if (roundChanged) {
    clearBackup();
    clearTimeout(draftTimer);
    loadedDraft = false;
    draftDirty = false;
    draftConflict = false;
    pendingRequest = null;
    historySignature = problemSignature = playerSignature = "";
  }
  state = next;
  if (roundChanged) {
    $("solution").value = "";
    restoringImages = true;
    solutionImages.clear();
    $("next-problem-json").value = "";
    $("next-problem").open = false;
    for (const id of ["problem-statement", "criteria", "reference"]) $(id).replaceChildren();
  }
  clockOffset = next.server_time - Date.now() / 1000;
  $("landing").hidden = true;
  $("session").hidden = false;
  $("connection").textContent = "На связи";
  $("session-code").textContent = state.code;
  $("round-label").textContent = `Раунд ${state.round}`;
  $("match-summary").textContent = `Завершено раундов: ${state.match.completed_rounds} · Победа в раунде — один бутерброд 🥪`;
  $("phase").textContent = { lobby: "Ожидание", active: "Идёт раунд", grading: "Проверка решений", finished: "Раунд завершён" }[state.phase];
  document.title = `${state.code} · Math Competition`;
  const player = me();
  if (!loadedDraft) {
    loadedDraft = true;
    draftRevision = player.draft_revision;
    $("solution").value = player.draft;
    try {
      const backup = JSON.parse(localStorage.getItem(draftKey()) || "null");
      if (backup && backup.text !== player.draft && state.phase !== "lobby") {
        $("solution").value = backup.text;
        draftDirty = true;
        draftConflict = backup.revision !== player.draft_revision;
        if (!draftConflict) draftTimer = setTimeout(saveDraft, 200);
      }
    } catch { /* Invalid/disabled local storage is ignored. */ }
    const restoringRound = state.round;
    restoringImages = true;
    window.mathDrafts.get(draftKey()).then(images => {
      if (state.round !== restoringRound || !images) return;
      solutionImages.images = images;
      solutionImages.render();
    }).catch(() => {imageBackupFailed = true;}).finally(() => {restoringImages = false; controls();});
    preview();
  } else if (!draftDirty && !savePromise) {
    draftRevision = player.draft_revision;
    if ($("solution").value !== player.draft) {
      $("solution").value = player.draft;
      preview();
    }
  }
  $("draft-conflict").hidden = !draftConflict;
  $("key-state").textContent = state.has_api_key ? "OpenRouter подключён. Ключ сохранён в аккаунте." : "Добавьте ключ OpenRouter в настройках перед началом.";
  $("remove-key").hidden = !state.has_api_key;
  $("shared-model").textContent = state.model;
  $("model-form").hidden = state.phase !== "lobby" || state.me !== state.host;
  $("topic-form").hidden = state.phase !== "lobby" || state.me !== state.host || state.source !== "bank";
  if (document.activeElement !== $("lobby-topic")) $("lobby-topic").value=state.topic || "";
  if (document.activeElement !== $("lobby-model")) $("lobby-model").value = state.model;
  $("lobby").hidden = state.phase !== "lobby";
  $("next-problem").hidden = state.phase !== "lobby" || state.round === 1 || state.me !== state.host || state.source === "bank";
  $("arena").hidden = state.phase === "lobby";
  $("histories").hidden = state.phase === "lobby";
  $("ready").textContent = player.ready ? "Не готов" : "Готов";
  $("lobby-hint").textContent = !state.has_api_key ? "Сначала подключите OpenRouter в настройках. Ключ сохранится для следующих игр." : state.players.length < 2 ? "Отправьте ссылку другу, чтобы начать." : player.ready ? "Ждём готовности соперника…" : "Нажмите «Готов», когда будете готовы начать.";
  renderPlayers();
  const problem = JSON.stringify(state.problem);
  if (problem !== problemSignature && state.problem) {
    problemSignature = problem;
    $("problem-title").textContent = state.problem.title;
    render($("problem-statement"), state.problem.statement);
    if (state.phase === "finished") {
      render($("criteria"), state.problem.criterions);
      render($("reference"), state.problem.reference_solution);
    }
  }
  $("result").hidden = state.phase !== "finished";
  $("revealed").hidden = state.phase !== "finished";
  $("feedback-hint").textContent = state.phase === "finished" ? "Решения и подробный разбор доступны" : "Решение соперника откроется после раунда";
  if (state.result) {
    const winner = state.players.find((p) => p.id === state.result.winner);
    $("result-title").textContent = winner ? `${winner.name} побеждает и получает 🥪` : "Ничья";
    $("result-reason").textContent = state.result.reason;
  }
  renderHistory();
  renderRounds();
  renderChat();
  controls();
  if (previousPhase === "lobby" && state.phase === "active") notice("Оба готовы. Условие открыто — можно решать.");
  if (previousPhase && previousPhase !== "finished" && state.phase === "finished") notice("Раунд завершён. Доступны решения обоих игроков и разбор.");
  if (roundChanged) notice(`Round ${state.round} is ready in the same session. Both players can click Ready when set.`);
}

function renderPlayers() {
  const signature = JSON.stringify([state.phase, state.players.map((p) => [p.id, p.name, p.ready, p.finalized, p.finalized_at, p.score, p.wins])]);
  if (signature === playerSignature) return;
  playerSignature = signature;
  const focused = document.activeElement?.id;
  const cards = document.createDocumentFragment();
  for (const p of state.players) {
    const card = document.createElement("div");
    card.className = "player-card";
    const top = document.createElement("div");
    top.className = "player-top";
    const name = document.createElement("strong");
    name.textContent = `${p.name}${p.id === state.me ? " (вы)" : ""}`;
    const label = document.createElement("span");
    label.className = "player-status";
    label.textContent = state.phase === "lobby" ? p.ready ? "Готов" : "Не готов" : p.finalized ? `Finalized · ${timeText(p.finalized_at)}` : "Решает";
    if (p.finalized) label.title = new Date(p.finalized_at * 1000).toLocaleString();
    top.append(name, label);
    const score = document.createElement("div");
    score.className = "score-info";
    score.id = `card-score-${p.id}`;
    score.tabIndex = 0;
    const number = document.createElement("span");
    number.className = "player-score";
    number.textContent = String(p.score.score);
    const suffix = document.createElement("span");
    suffix.className = "muted";
    suffix.textContent = " / 10 · оценка решения";
    const tip = document.createElement("span");
    tip.className = "score-tooltip";
    tip.role = "tooltip";
    tip.id = `score-${p.id}`;
    tip.textContent = `Best verdict: ${p.score.best}. Counted: ${p.score.counted}. Penalty: ${p.score.penalty}.`;
    score.setAttribute("aria-describedby", tip.id);
    score.append(number, suffix, tip);
    const wins = document.createElement("div");
    wins.className = "win-count";
    wins.textContent = `${p.wins} 🥪`;
    wins.setAttribute("aria-label", `Бутерброды: ${p.wins}`);
    wins.title = "Один бутерброд за победу в раунде";
    card.append(top, wins, score);
    cards.append(card);
  }
  if (state.players.length === 1) {
    const waiting = document.createElement("div");
    waiting.className = "player-card muted";
    waiting.textContent = "Ждём соперника…";
    cards.append(waiting);
  }
  $("player-cards").replaceChildren(cards);
  if (focused?.startsWith("card-score-")) $(focused)?.focus();
}

function controls() {
  if (!state) return;
  const p = me();
  const expired = p.deadline !== null && now() >= p.deadline;
  const locked = state.phase !== "active" || p.finalized || expired;
  const pending = p.submissions.filter((s) => s.status === "pending").length;
  $("solution").readOnly = locked;
  $("submit").disabled = locked || actionBusy || draftConflict || (solutionImages.busy || restoringImages) || !state.has_api_key || (!$("solution").value.trim() && !solutionImages.value.length);
  solutionImages.setDisabled(locked || actionBusy || restoringImages);
  $("finalize").disabled = locked || actionBusy || solutionImages.busy;
  const latest = p.submissions[p.submissions.length - 1];
  const changed = !!($("solution").value.trim() || solutionImages.value.length) && (!latest || latest.solution !== $("solution").value || JSON.stringify(latest.images || []) !== JSON.stringify(solutionImages.value));
  $("finalize").textContent = p.finalized ? "Завершено" : changed ? "Отправить и завершить" : "Завершить";
  $("finalize").disabled = locked || actionBusy || solutionImages.busy || draftConflict || (changed && !state.has_api_key);
  $("surrender").disabled = locked || actionBusy;
  $("ready").disabled = actionBusy || state.players.length < 2 || !state.has_api_key;
  $("rematch").disabled = actionBusy || state.phase !== "finished";
  let hint = "";
  if (state.phase === "grading") hint = "Ждём окончания проверки…";
  else if (p.finalized && pending) hint = `Finalized · ${pending} still grading. Your score is provisional.`;
  else if (p.finalized) hint = p.submissions.length ? "Вы завершили решение." : "Finalized without a submission. No solution was sent for grading.";
  else if (pending) hint = `${pending} grading in background. You may submit again or finalize.`;
  else if (!state.has_api_key) hint = "Подключите OpenRouter в настройках.";
  else if (!p.submissions.length) hint = "Решение ещё не отправлено на проверку.";
  $("submission-hint").textContent = hint;
  $("draft-status").textContent = imageBackupFailed ? "Изображения не сохранены локально" : restoringImages ? "Восстановление…" : draftConflict ? "Конфликт черновиков" : savePromise ? "Сохраняется…" : draftDirty ? "Не сохранено" : "Сохранено";
  $("deadline").hidden = p.deadline === null || p.finalized || state.phase === "finished";
  if (!$("deadline").hidden) {
    const remaining = Math.max(0, Math.ceil(p.deadline - now()));
    $("deadline").textContent = remaining ? `Your opponent finalized. Time left: ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "Deadline expired. Finalizing automatically…";
  }
}

function renderHistory(players = state.players, target = $("history")) {
  if (target === $("history")) {
    const signature = JSON.stringify(players.map((p) => [p.name, p.submissions]));
    if (signature === historySignature) return;
    historySignature = signature;
  }
  const opened = new Set([...target.querySelectorAll("details[open]")].map((d) => d.id));
  const content = document.createDocumentFragment();
  for (const p of players) {
    const heading = document.createElement("h3");
    heading.className = "history-owner";
    heading.textContent = p.name + (p.id === state.me ? " · your submissions" : " · opponent");
    content.append(heading);
    if (!p.submissions.length) {
      const empty = document.createElement("p");
      empty.className = "empty-history";
      empty.textContent = "Попыток пока нет.";
      content.append(empty);
    }
    for (const [index, s] of [...p.submissions.entries()].reverse()) {
      const entry = document.createElement("details");
      entry.className = "submission";
      entry.id = `submission-${s.id}`;
      entry.open = opened.has(entry.id);
      const summary = document.createElement("summary");
      summary.append(document.createTextNode(`Submission ${index + 1}`));
      const time = document.createElement("time");
      time.dateTime = new Date(s.submitted_at * 1000).toISOString();
      time.textContent = timeText(s.submitted_at);
      time.title = new Date(s.submitted_at * 1000).toLocaleString();
      const verdict = document.createElement("span");
      verdict.className = "verdict";
      verdict.textContent = s.status === "pending" ? "Проверяется…" : s.status === "failed" ? "Ошибка · без штрафа" : `${s.verdict} / 10`;
      summary.append(time, verdict);
      const feedback = document.createElement("div");
      feedback.className = "feedback";
      const section = (title, text) => {
        const h = document.createElement("h3");
        h.textContent = title;
        const body = document.createElement("div");
        body.className = "rendered";
        render(body, text);
        feedback.append(h, body);
      };
      if (s.grade) { section("Разбор", s.grade.reasoning); section("Обоснование", s.grade.evidence); }
      else if (s.status === "graded") { const text = document.createElement("p"); text.className = "muted"; text.textContent = "Подробный разбор откроется после раунда."; feedback.append(text); }
      if (s.error) { const error = document.createElement("p"); error.className = "error"; error.textContent = s.error; feedback.append(error); }
      if (s.solution !== undefined) {
        section(p.id === state.me ? "Отправленное решение" : `${p.name}’s submitted solution`, s.solution || "Решение на изображениях.");
        window.appendSolutionImages(feedback, s.images || []);
      }
      else { const privateText = document.createElement("p"); privateText.className = "muted"; privateText.textContent = "Решение соперника откроется после раунда."; feedback.append(privateText); }
      entry.append(summary, feedback);
      content.append(entry);
    }
  }
  target.replaceChildren(content);
}

function renderRounds() {
  const rounds = state.previous_rounds;
  $("round-history").hidden = !rounds.length;
  const signature = JSON.stringify(rounds);
  if (signature === roundHistorySignature) return;
  roundHistorySignature = signature;
  const list = $("round-history-list");
  const opened = new Set([...list.querySelectorAll("details[open]")].map((entry) => entry.id));
  list.replaceChildren();
  for (const round of [...rounds].reverse()) {
    const entry = document.createElement("details");
    entry.id = `round-${round.round}`;
    entry.className = "submission";
    const summary = document.createElement("summary");
    const winner = state.players.find((p) => p.id === round.result.winner);
    summary.textContent = `Round ${round.round} · ${round.title} · ${winner ? `${winner.name} wins` : "Draw"} · ${state.players.map((p) => round.scores[p.id]).join(" : ")}`;
    const body = document.createElement("div");
    body.className = "feedback";
    let loaded = false;
    let busy = false;
    entry.addEventListener("toggle", async () => {
      if (!entry.open || loaded || busy) return;
      busy = true;
      body.textContent = "Загрузка раунда…";
      try {
        const archived = await api(sessionPath(`/rounds/${round.round}`));
        body.replaceChildren();
        for (const [title, text] of [["Условие", archived.problem.statement], ["Критерии", archived.problem.criterions], ["Эталонное решение", archived.problem.reference_solution]]) {
          const heading = document.createElement("h3");
          heading.textContent = title;
          const content = document.createElement("div");
          content.className = "rendered";
          render(content, text);
          body.append(heading, content);
        }
        const history = document.createElement("div");
        renderHistory(archived.players, history);
        body.append(history);
        loaded = true;
      } catch (error) { body.textContent = error.message; }
      finally { busy = false; }
    });
    entry.append(summary, body);
    entry.open = opened.has(entry.id);
    list.append(entry);
  }
}

function renderChat() {
  const signature = JSON.stringify(state.chat);
  if (signature === chatSignature) return;
  chatSignature = signature;
  const container = $("chat-messages");
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  const content = document.createDocumentFragment();
  for (const message of state.chat) {
    const entry = document.createElement("div");
    entry.className = "chat-message";
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    const name = document.createElement("strong");
    name.textContent = message.kind === "solution" ? `Reference solution · Round ${message.round}` : state.players.find((p) => p.id === message.player_id)?.name || "Player";
    const time = document.createElement("time");
    time.textContent = timeText(message.sent_at);
    meta.append(name, time);
    const text = document.createElement(message.kind === "solution" ? "div" : "p");
    if (message.kind === "solution") {
      entry.classList.add("chat-solution");
      text.className = "rendered";
      render(text, message.text);
    } else text.textContent = message.text;
    entry.append(meta, text);
    content.append(entry);
  }
  if (!state.chat.length) { const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "Здесь можно обсудить игру."; content.append(empty); }
  container.replaceChildren(content);
  if (atBottom) container.scrollTop = container.scrollHeight;
}

async function saveDraft() {
  clearTimeout(draftTimer);
  if (savePromise) return savePromise;
  if (!draftDirty || draftConflict || !state || state.phase === "lobby") return;
  const savingRound = state.round;
  savePromise = (async () => {
    while (draftDirty && !draftConflict && state.phase !== "lobby" && state.round === savingRound) {
      const text = $("solution").value;
      try {
        const result = await api(sessionPath("/draft"), "PUT", { text, revision: draftRevision, round: savingRound });
        if (state.round !== savingRound) return;
        draftRevision = result.players.find((p) => p.id === result.me).draft_revision;
        draftDirty = $("solution").value !== text;
        apply(result);
        if (draftDirty) backupDraft(); else clearBackup();
      } catch (error) {
        if (state.round !== savingRound) return;
        if (error.status === 409) {
          draftConflict = true;
          $("draft-conflict").hidden = false;
          notice(error.message, true);
        } else {
          notice("Draft could not reach the server. Your local copy is kept; reconnecting will retry.", true);
        }
        break;
      }
    }
  })();
  controls();
  await savePromise;
  savePromise = null;
  controls();
}

async function poll() {
  clearTimeout(pollTimer);
  if (!code) return;
  try {
    apply(await api(sessionPath()));
    if (draftDirty && !draftConflict && !savePromise) saveDraft();
  } catch (error) {
    $("connection").textContent = "Переподключение…";
    if (error.status === 401 || error.status === 403) {
      $("session").hidden = true;
      $("landing").hidden = false;
      $("join-code").value = code;
      notice("Присоединитесь к дуэли по приглашению.");
      return;
    }
    notice(error.message, true);
    if (error.status === 404) { $("landing").hidden = false; $("join-code").value = code; return; }
  }
  pollTimer = setTimeout(poll, 1200);
}

function enter(next) {
  code = next.code;
  history.replaceState(null, "", `/s/${code}`);
  apply(next);
  pollTimer = setTimeout(poll, 1200);
}

async function action(callback) {
  if (actionBusy) return;
  actionBusy = true;
  controls();
  try { await callback(); } catch (error) { notice(error.message, true); }
  finally { actionBusy = false; controls(); }
}

async function submitSolution(finalize = false) {
  if ($("submit").disabled) return;
  await action(async () => {
    const solution = $("solution").value;
    const images = solutionImages.value;
    saveDraft();
    if (!pendingRequest || pendingRequest.solution !== solution || pendingRequest.images.length !== images.length || pendingRequest.images.some((image, index) => image !== images[index])) {
      pendingRequest = { solution, images, request_id: requestId(), round: state.round };
    }
    const next = await api(sessionPath("/submissions"), "POST", {...pendingRequest, finalize});
    pendingRequest = null;
    apply(next);
    notice("Решение принято. Проверка идёт в фоне.");
  });
}

async function init() {
  if (!render) { notice("Rendering libraries could not load. Check your connection and reload.", true); return; }
  solutionImages = new window.SolutionImages($("solution-images"), $("image-attachments"), $("solution"), () => {
    controls();
    if (state && !restoringImages) window.mathDrafts.put(draftKey(), solutionImages.value).then(() => {imageBackupFailed=false; controls();}).catch(() => {imageBackupFailed=true; controls();});
  }, notice);
  solutionImages.setDisabled(true);
  $("create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    action(async () => {
      let problem;
      if (!window.mathAccount.user) { window.mathAccount.open(); return; }
      try { problem = $("problem-json").value.trim() ? JSON.parse($("problem-json").value) : undefined; } catch { throw new Error("Проверьте формат JSON задачи."); }
      enter(await api("/api/sessions", "POST", { name: window.mathAccount.user.display_name, topic: $("create-topic").value || null, ...(problem ? {problem} : {}), model: $("create-model").value }));
      notice("Дуэль создана. Отправьте приглашение другу.");
    });
  });
  $("create-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 150000) throw new Error("Problem JSON must be smaller than 150 KB.");
      $("problem-json").value = await file.text();
      JSON.parse($("problem-json").value);
      notice("Problem JSON loaded.");
    } catch (error) { notice(error.message, true); }
    event.target.value = "";
  });
  $("join-form").addEventListener("submit", (event) => {
    event.preventDefault();
    action(async () => {
      if (!window.mathAccount.user) {window.mathAccount.open(); return;}
      const raw = $("join-code").value.trim();
      const inviteCode = (raw.includes("/") ? new URL(raw, location.origin).pathname.split("/").filter(Boolean).pop() : raw).toUpperCase();
      enter(await api(`/api/sessions/${encodeURIComponent(inviteCode)}/join`, "POST", { name: window.mathAccount.user.display_name }));
      notice("Вы присоединились к дуэли.");
    });
  });
  $("copy-invite").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(`${location.origin}/s/${code}`); notice("Приглашение скопировано."); }
    catch { notice(`Invite link: ${location.origin}/s/${code}`); }
  });
  $("key-form").addEventListener("submit", (event) => {
    event.preventDefault();
    action(async () => {
      if (!$("session-key").value.trim()) throw new Error("Enter an OpenRouter API key.");
      await api("/api/key", "PUT", { api_key: $("session-key").value });
      $("session-key").value = "";
      if (state) apply(await api(sessionPath()));
      notice("Ключ сохранён.");
    });
  });
  $("remove-key").addEventListener("click", () => action(async () => {
    await api("/api/key", "DELETE");
    apply(await api(sessionPath()));
    notice("API key forgotten.");
  }));
  $("model-form").addEventListener("submit", (event) => {
    event.preventDefault();
    action(async () => {
      apply(await api(sessionPath("/model"), "PUT", { model: $("lobby-model").value, round: state.round }));
      notice("Shared model updated. Both players need to click Ready again.");
    });
  });
  $("topic-form").addEventListener("submit", event => {event.preventDefault(); action(async () => {apply(await api(sessionPath('/topic'),'PUT',{topic:$('lobby-topic').value || null,round:state.round}));notice('Тема обновлена. Подтвердите готовность заново.');});});
  $("ready").addEventListener("click", () => action(async () => {
    apply(await api(sessionPath("/ready"), "PUT", { ready: !me().ready, round: state.round }));
  }));
  $("rematch").addEventListener("click", () => action(async () => {
    apply(await api(sessionPath("/rematch"), "POST", { round: state.round }));
  }));
  $("next-problem-form").addEventListener("submit", (event) => {
    event.preventDefault();
    action(async () => {
      let problem;
      try { problem = JSON.parse($("next-problem-json").value); } catch { throw new Error("Problem must be valid JSON."); }
      apply(await api(sessionPath("/problem"), "PUT", { problem, round: state.round }));
      notice("Problem updated for this round. Both players need to click Ready again.");
    });
  });
  $("next-problem-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 150000) throw new Error("Problem JSON must be smaller than 150 KB.");
      const text = await file.text();
      JSON.parse(text);
      $("next-problem-json").value = text;
    } catch (error) { notice(error.message, true); }
    event.target.value = "";
  });
  $("solution").addEventListener("input", () => {
    draftDirty = true;
    backupDraft();
    preview();
    controls();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 500);
  });
  $("solution").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submitSolution(); }
  });
  $("submit").addEventListener("click", () => submitSolution());
  $("finalize").addEventListener("click", async () => {
    const latest = me().submissions.at(-1);
    const changed = !!($("solution").value.trim() || solutionImages.value.length) && (!latest || latest.solution !== $("solution").value || JSON.stringify(latest.images || []) !== JSON.stringify(solutionImages.value));
    if (changed) return submitSolution(true);
    if (!latest && !confirm("Завершить без отправленного решения? Вы получите 0 баллов.")) return;
    action(async () => { await saveDraft(); apply(await api(sessionPath("/finalize"), "POST", {round:state.round})); notice("Вы завершили решение. У соперника остаётся до пяти минут."); });
  });
  $("surrender").addEventListener("click", () => {
    if (!confirm("Сдаться и завершить текущий раунд? Текст в редакторе не будет отправлен. Уже отправленные решения учитываются.")) return;
    action(async () => {await saveDraft(); apply(await api(sessionPath("/finalize"), "POST", {round:state.round}));});
  });
  $("keep-local").addEventListener("click", () => action(async () => {
    apply(await api(sessionPath()));
    draftConflict = false;
    draftRevision = me().draft_revision;
    $("draft-conflict").hidden = true;
    backupDraft();
    await saveDraft();
  }));
  $("use-saved").addEventListener("click", () => action(async () => {
    draftDirty = false;
    draftConflict = false;
    clearBackup();
    apply(await api(sessionPath()));
    preview();
  }));
  $("chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("chat-input").value;
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      apply(await api(sessionPath("/chat"), "POST", { text }));
      if ($("chat-input").value === text) $("chat-input").value = "";
    } catch (error) { notice(error.message, true); }
    finally { button.disabled = false; }
  });
  setInterval(controls, 250);
  window.addEventListener("online", () => { if (code) poll(); });
  window.addEventListener("beforeunload", event => {if (solutionImages.busy || imageBackupFailed) {event.preventDefault(); event.returnValue="";}});
  window.addEventListener("pagehide", () => { if (draftDirty && state) backupDraft(); });
  document.querySelectorAll('[data-workspace]').forEach(button => button.addEventListener('click', () => {
    document.body.dataset.workspace = button.dataset.workspace;
    document.querySelectorAll('[data-workspace]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
  window.addEventListener('accountchange', event => {if (state && event.detail) {state.has_api_key=event.detail.has_api_key; controls();}});
  await window.mathAccount.ready;
  try {
    const topics = await api('/api/problems/topics');
    for (const topic of topics.topics) {const option = document.createElement('option'); option.value=topic.slug; option.textContent=`${topic.label} · ${topic.unseen_count ?? topic.count}`; $('create-topic').append(option); $('lobby-topic').append(option.cloneNode(true));}
    const data = await api("/api/sessions");
    $("create-model").value = data.model;
    $("recent").hidden = !data.sessions.length;
    for (const session of data.sessions) {
      const link = document.createElement("a");
      link.className = "recent-link";
      link.href = `/s/${session.code}`;
      link.textContent = `${session.code} · ${session.names.join(" vs ")} · ${session.phase}`;
      $("recent-list").append(link);
    }
    $("connection").textContent = "На связи";
    if (code) await poll(); else $("landing").hidden = false;
  } catch (error) { $("landing").hidden = false; notice(error.message, true); }
}

init();
