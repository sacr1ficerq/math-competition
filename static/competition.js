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
const appealDrafts = new Map();
const appealRequests = new Set();
let imageBackupFailed = false;
let acceptedPayload = null;
let keyPrompted = false;
let keyboardNavigation = false;
let readinessWithdrawal = null;
let reviewTab = "own";
let noticeTimer;
const initializedReviews = new Set();
let lobbyTopicsSignature = "";
let inviteFeedbackTimer;
let lobbyMode = null;
let customProblemDirty = false;
let customProblemForm;
let chatOpen = false;
let chatSending = false;
let movingChat = false;
let chatOpenedBefore = false;
const mobileChat = matchMedia('(max-width: 1000px)');
const deadlineMotion = matchMedia('(prefers-reduced-motion: reduce)');
deadlineMotion.addEventListener('change',event=>{if(event.matches)document.getElementById('deadline')?.getAnimations().forEach(animation=>animation.cancel());});

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
  clearTimeout(noticeTimer);
  if (!error && message) noticeTimer=setTimeout(()=>{$("notice").textContent="";},4000);
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
    const error = new Error(message || `Не удалось выполнить запрос (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const me = () => state?.players.find((p) => p.id === state.me);
const sessionPath = (suffix = "") => `/api/sessions/${encodeURIComponent(code)}${suffix}`;
const timeText = (value) => new Date(value * 1000).toLocaleTimeString("ru-RU", {hour12:false});
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
    acceptedPayload = null;
    keyPrompted = false;
    historySignature = problemSignature = playerSignature = "";
  }
  state = next;
  if (roundChanged) {
    $("solution").value = "";
    restoringImages = true;
    solutionImages.clear();
    $("next-problem-json").value = "";
    customProblemForm?.reset();
    lobbyMode = null;
    customProblemDirty = false;
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
      solutionImages.images = Array.isArray(images) ? images : images.images || [];
      acceptedPayload = Array.isArray(images) ? null : images.accepted || null;
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
  const savedTaskMode=state.source === 'custom' ? 'custom' : state.topic ? 'topic' : 'random';
  if(!lobbyMode || state.phase !== 'lobby')lobbyMode=savedTaskMode;
  $('topic-form').hidden=state.phase !== 'lobby' || state.me !== state.host || lobbyMode !== 'topic';
  $('lobby-task-controls').hidden=state.me !== state.host;
  $('lobby-task-summary').hidden=false;
  $('task-selection-title').textContent=state.round === 1 ? 'Задача дуэли' : 'Следующая задача';
  const selectedTopic=state.available_topics?.find(topic=>topic.slug===state.topic);
  $('lobby-task-summary').textContent=savedTaskMode === 'custom' ? 'Своя задача · условие откроется после старта' : savedTaskMode === 'topic' ? `${selectedTopic?.label || state.topic} · новая задача для обоих` : 'Случайная задача · новая для обоих';
  $('task-owner-note').hidden=state.me===state.host;
  $('task-owner-note').textContent=`Задачу выбирает ${state.players.find(p=>p.id===state.host)?.name || 'создатель комнаты'}`;
  document.querySelectorAll('[data-lobby-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.lobbyMode===lobbyMode)));
  const topicsSignature=JSON.stringify(state.available_topics || []);
  if(topicsSignature !== lobbyTopicsSignature){lobbyTopicsSignature=topicsSignature;const current=$('lobby-topic').value;$('lobby-topic').replaceChildren(new Option('Выберите тему',''));for(const topic of state.available_topics || [])$('lobby-topic').append(new Option(topic.label,topic.slug));$('lobby-topic').value=current;}
  if(document.activeElement !== $('lobby-topic'))$('lobby-topic').value=state.source === 'bank' ? state.topic || '' : '';
  $("lobby").hidden = !!state.closed_at || state.phase !== "lobby";
  const waitingForOpponent=state.players.length < 2;
  $('lobby-title').textContent=waitingForOpponent?'Пригласите друга':`Раунд ${state.round}`;
  $('lobby-description').textContent=waitingForOpponent?'Отправьте ссылку другу — он присоединится к этой комнате.':'Условие откроется одновременно, когда вы оба будете готовы.';
  $('invite-url').value=`${location.origin}/s/${state.code}`;
  $('copy-lobby-invite').classList.toggle('primary',waitingForOpponent);
  $('copy-lobby-invite').classList.toggle('invite-copy-secondary',!waitingForOpponent);
  if(!inviteFeedbackTimer || !waitingForOpponent)$('invite-feedback').textContent=waitingForOpponent?'Ждём второго игрока.':'Вы оба в комнате. Подтвердите готовность.';
  $('lobby').dataset.players=waitingForOpponent?'one':'two';
  $('lobby-readiness').hidden=waitingForOpponent;
  $('lobby-model-state').textContent=`Проверка решений · ${state.model}`;
  $('edit-custom-task').hidden=state.me!==state.host || lobbyMode!=='custom';
  if(state.phase!=='lobby' && $('custom-task-dialog').open)$('custom-task-dialog').close();
  document.body.dataset.phase=state.closed_at?"closed":state.phase;
  $("next-problem").hidden = state.phase !== "lobby" || state.me !== state.host || lobbyMode !== "custom";
  $("topic-availability").textContent = selectedTopic ? `Новых задач для вас обоих: ${selectedTopic.unseen_count}.` : "Выберите тему перед подтверждением готовности.";
  window.mathUI.syncPickers();
  $("arena").hidden = !!state.closed_at || state.phase === "lobby" || state.phase === "finished";
  $("closed-room-state").hidden = !state.closed_at || state.phase === "finished";
  $("histories").hidden = state.phase === "lobby" || (state.phase !== "finished" && !player.submissions.length);
  $("ready").textContent = player.ready ? "Не готов" : "Готов";
  if(state.closed_at)$("phase").textContent="Закрыта";
  $("lobby-hint").textContent = state.players.length < 2 ? "Отправьте ссылку другу, чтобы начать." : player.ready ? "Ждём готовности соперника…" : "Нажмите «Готов», когда будете готовы начать.";
  renderPlayers();
  const problem = JSON.stringify(state.problem);
  if (problem !== problemSignature && state.problem) {
    problemSignature = problem;
    $("problem-title").textContent = state.problem.title;
    $("review-problem-title").textContent = state.problem.title;
    render($("review-problem-statement"), state.problem.statement);
    render($("problem-statement"), state.problem.statement);
    if (state.phase === "finished") {
      render($("criteria"), state.problem.criterions);
      render($("reference"), state.problem.reference_solution || "Автор не добавил полное решение.");
    }
  }
  $("result").hidden = state.phase !== "finished";
  $("revealed").hidden = state.phase !== "finished";
  $("feedback-hint").textContent = "";
  if (state.result) {
    const winner = state.players.find((p) => p.id === state.result.winner);
    $("result-title").textContent = state.appeals_pending ? "Результат уточняется" : winner ? winner.id === state.me ? "Ваша победа" : `${winner.name} побеждает` : "Ничья";
    $("result-reason").textContent = state.appeals_pending ? "Предварительный результат: рассматривается апелляция. Итог и счёт серии могут измениться." : resultReason();
    $("result-reason").hidden = !$("result-reason").textContent;
  }
  const historyHost = state.phase === "finished" ? $("result-history-host") : state.closed_at ? $("closed-history-host") : $("active-history-host");
  if ($("histories").parentElement !== historyHost) historyHost.append($("histories"));
  renderResultComparison();
  if(state.phase!=='finished')renderHistory();
  $('round-review-link').href=`/s/${encodeURIComponent(code)}?round=${state.round}`;
  const ownWorks=me()?.submissions || [];
  const appealed=ownWorks.find(work=>['pending','graded'].includes(work.appeal?.status));
  const eligible=ownWorks.filter(work=>work.appeal_eligible).sort((a,b)=>(typeof b.verdict==='number'?b.verdict:-Infinity)-(typeof a.verdict==='number'?a.verdict:-Infinity))[0];
  const appealWork=appealed || (!state.closed_at?eligible:null);
  $('result-appeal-link').hidden=state.phase!=='finished' || !appealWork;
  if(appealWork){$('result-appeal-link').href=`/s/${encodeURIComponent(code)}?round=${state.round}&view=appeal&attempt=${encodeURIComponent(appealWork.id)}`;$('result-appeal-link').textContent=appealed?appealed.appeal.status==='pending'?'Апелляция рассматривается':'Посмотреть апелляцию':'Подать апелляцию';}

  renderRounds();
  renderChat();
  controls();
  window.dispatchEvent(new CustomEvent('math:state',{detail:state}));
  if (previousPhase === "lobby" && state.phase === "active") notice("Оба готовы. Условие открыто — можно решать.");
  if (previousPhase && previousPhase !== "finished" && state.phase === "finished") notice("");
  if (roundChanged) notice(`Раунд ${state.round}. Подтвердите готовность к новой задаче.`);
  if ((previousPhase && previousPhase !== "finished" && state.phase === "finished") || roundChanged) {
    const target=state.phase === "finished" ? $("result-title") : $("lobby-title");
    const section=state.phase === "finished" ? $("result") : $("lobby");
    const targetRound=state.round;
    requestAnimationFrame(()=>{if(state.round!==targetRound)return;target.dataset.keyboardFocus=String(keyboardNavigation);target.focus({preventScroll:true});section.scrollIntoView({block:"start",behavior:"auto"});});
  }
}

function renderPlayers() {
  const signature = JSON.stringify([state.phase, state.closed_at, state.players.map((p) => [p.id, p.name, p.ready, p.finalized, p.finalized_at, p.score, p.wins])]);
  if (signature === playerSignature) return;
  playerSignature = signature;
  const focused = document.activeElement?.id;
  const cards = document.createDocumentFragment();
  for (const p of state.players) {
    const card = document.createElement("div");
    card.className = "player-card";
    card.dataset.ready=String(p.ready);
    const avatar=document.createElement("span");avatar.className="player-initials";avatar.setAttribute("aria-hidden","true");avatar.textContent=p.name.trim().split(/\s+/).slice(0,2).map(part=>part[0]).join("").toUpperCase();
    card.append(avatar);
    const top = document.createElement("div");
    top.className = "player-top";
    const name = document.createElement("strong");
    name.textContent = `${p.name}${p.id === state.me ? " (вы)" : ""}`;
    name.title=name.textContent;
    const label = document.createElement("span");
    label.className = "player-status";
    label.textContent = state.closed_at ? "Комната закрыта" : state.phase === "lobby" ? p.ready ? "Готов" : "Не готов" : p.finalized ? state.phase === "finished" ? "Раунд завершён" : `Завершил в ${timeText(p.finalized_at)}` : "Решает";
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
    tip.textContent = `Лучшая оценка: ${p.score.best}. Проверок: ${p.score.counted}. Штраф: ${p.score.penalty}.`;
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
    const seat=document.createElement("span");seat.className="player-initials";seat.textContent="?";seat.setAttribute("aria-hidden","true");const caption=document.createElement("strong");caption.textContent="Ждём соперника";waiting.append(seat,caption);
    cards.append(waiting);
  }
  $("player-cards").classList.toggle("scoreboard",state.phase!=="lobby"||!!state.closed_at);
  if(state.phase!=="lobby"||state.closed_at){
    const sides=[...cards.children];
    const tally=document.createElement("div");tally.className="match-tally";
    if(state.phase==="finished"){const label=document.createElement("span");label.className="series-label";label.textContent="Бутерброды в серии";tally.append(label);}
    sides.forEach((card,index)=>{card.classList.add("match-player");card.querySelector(".player-initials")?.remove();const wins=card.querySelector(".win-count");if(wins){if(state.phase==="finished")wins.textContent=state.players[index].wins;wins.setAttribute("aria-label",`Бутерброды ${state.players[index].name}: ${state.players[index].wins}`);tally.append(wins);}if(!index){const colon=document.createElement("span");colon.className="tally-colon";colon.textContent=":";colon.setAttribute("aria-hidden","true");tally.append(colon);}});
    cards.insertBefore(tally,sides[1]);
  }else{
    const axis=document.createElement("div");axis.className="lobby-series";
    const caption=document.createElement('span');caption.textContent='Счёт серии';
    const tally=document.createElement('strong');tally.textContent=`${state.players[0]?.wins || 0} : ${state.players[1]?.wins || 0}`;
    axis.append(caption,tally);cards.insertBefore(axis,cards.children[1]);
  }
  $("player-cards").replaceChildren(cards);
  if (focused?.startsWith("card-score-")) $(focused)?.focus();
}

function controls() {
  if (!state) return;
  const p = me();
  const expired = p.deadline !== null && now() >= p.deadline;
  const locked = !!state.closed_at || state.phase !== "active" || p.finalized || expired;
  const pending = p.submissions.filter((s) => s.status === "pending").length;
  $("solution").readOnly = locked;
  $("submit").disabled = locked || actionBusy || draftConflict || (solutionImages.busy || restoringImages) || (!$("solution").value.trim() && !solutionImages.value.length);
  solutionImages.setDisabled(locked || actionBusy || restoringImages);
  $("finalize").disabled = locked || actionBusy || solutionImages.busy;
  const changed = hasUnsubmittedChanges();
  $("finalize").textContent = p.finalized ? "Сдано" : changed ? "Отправить и сдать" : "Сдать";
  $("finalize").disabled = locked || actionBusy || solutionImages.busy || restoringImages || draftConflict;
  $("surrender").disabled = locked || actionBusy;
  const customPending=state.phase === 'lobby' && state.me === state.host && lobbyMode === 'custom' && (state.source !== 'custom' || customProblemDirty);
  const topicPending=state.phase === 'lobby' && state.me === state.host && lobbyMode === 'topic' && (state.source !== 'bank' || !state.topic);
  const randomPending=state.phase === 'lobby' && state.me === state.host && lobbyMode === 'random' && (state.source !== 'bank' || !!state.topic);
  $('ready').disabled=!!state.closed_at || actionBusy || !!readinessWithdrawal || state.players.length < 2 || customPending || topicPending || randomPending;
  if(customPending)$('lobby-hint').textContent='Добавьте и примените свою задачу перед стартом.';
  if(topicPending)$('lobby-hint').textContent='Выберите тему задачи перед стартом.';
  if(randomPending)$('lobby-hint').textContent='Не удалось применить выбор. Выберите «Случайная» ещё раз.';
  $("rematch").hidden = !!state.closed_at;
  $("close-room").hidden = !!state.closed_at || state.me !== state.host;
  $("copy-invite").hidden = !!state.closed_at || state.players.length>=2;
  document.querySelector(".lobby-invite").hidden=!!state.closed_at || state.players.length>=2;
  $("copy-lobby-invite").hidden = !!state.closed_at || state.players.length>=2;
  $("close-room").disabled = actionBusy;
  $("chat-input").disabled = !!state.closed_at;
  $("chat-form").querySelector("button").disabled = !!state.closed_at || chatSending || !$("chat-input").value.trim();
  $("chat-input").placeholder = state.closed_at?"Комната закрыта":"Сообщение сопернику…";
  $("rematch").disabled = !!state.closed_at || actionBusy || state.phase !== "finished" || !!state.appeals_pending;
  $("rematch").title = state.appeals_pending ? "Дождитесь рассмотрения апелляции" : "";
  let hint = "";
  if (state.phase === "grading") hint = "Ждём окончания проверки…";
  else if (p.finalized && pending) hint = `Завершено · проверяется попыток: ${pending}. Оценка предварительная.`;
  else if (p.finalized) hint = p.submissions.length ? "Вы завершили решение." : "Вы завершили раунд без отправленного решения.";
  else if (pending) hint = `Проверяется попыток: ${pending}. Можно продолжать решать.`;
  else if (!state.has_api_key && keyPrompted) hint = "Для проверки нужен ключ OpenRouter. Решение и черновик сохраняются.";
  else if (!p.submissions.length) hint = "Решение ещё не отправлено на проверку.";
  $("submission-hint").textContent = hint;
  $("connect-key").hidden = !!state.closed_at || !keyPrompted || state.has_api_key || state.phase !== "active" || p.finalized;
  $("draft-status").textContent = imageBackupFailed ? "Изображения не сохранены локально" : restoringImages ? "Восстановление…" : draftConflict ? "Конфликт черновиков" : savePromise ? "Сохраняется…" : draftDirty ? "Не сохранено" : "Сохранено";
  renderDeadline(p);
}

function renderDeadline(player) {
  const timer=$("deadline");
  timer.hidden=!!state.closed_at || player.deadline === null || player.finalized || state.phase === "finished";
  if(timer.hidden)return;
  const seconds=Math.max(0,player.deadline-now());
  const remaining=Math.ceil(seconds);
  const urgency=remaining===0?'expired':remaining<=15?'critical':remaining<=60?'urgent':'normal';
  const key=`${state.code}:${state.round}:${player.deadline}`;
  const firstEntry=timer.dataset.entryKey!==key;
  const value=`${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`;
  if($('deadline-value').textContent!==value)$('deadline-value').textContent=value;
  $('deadline-value').dateTime=`PT${remaining}S`;
  $('deadline-caption').textContent=remaining?'До завершения':'Завершаем раунд…';
  $('deadline-progress').style.strokeDashoffset=String(100-Math.min(1,seconds/300)*100);
  timer.setAttribute('aria-label',remaining?`Соперник сдал работу. До завершения ${value}.`:'Время истекло. Завершаем раунд.');
  if(firstEntry||timer.dataset.urgency!==urgency){
    $('deadline-announcement').textContent=urgency==='expired'?'Время истекло. Завершаем раунд.':urgency==='critical'?'До завершения осталось 15 секунд.':urgency==='urgent'?'До завершения осталась минута.':'Соперник сдал работу. У вас осталось до пяти минут.';
  }
  timer.dataset.urgency=urgency;
  if(firstEntry){
    timer.dataset.entryKey=key;
    if(!deadlineMotion.matches)timer.animate([{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:200,easing:'cubic-bezier(.23,1,.32,1)'});
  }
}

function resultReason() {
  if(state.result?.reason === "Equal scores; earlier finalization wins.") return "Оценки равны. Побеждает тот, кто завершил решение первым.";
  if(state.result?.reason === "Higher final score.") return "";
  return state.result?.winner ? "За победу в раунде — один бутерброд." : "Одинаковые результаты. Бутерброды не начисляются.";
}

function finishLabel(player) {
  if (!player.finalized_at) return "Ещё не завершено";
  const equal = state.result && new Set(state.players.map(item=>item.score.score)).size === 1;
  const order=equal && state.result.winner ? state.result.winner===player.id ? "Сдал первым" : "Сдал вторым" : "Завершено";
  return `${order} · ${timeText(player.finalized_at)}`;
}

function renderResultComparison() {
  if (state.phase !== "finished") return;
  const signature=JSON.stringify([state.players.map(player=>[player.id,player.score,player.finalized_at,player.submissions.map(submission=>[submission.id,submission.appeal?.status,submission.appeal?.old_verdict,submission.appeal?.effective_verdict])]),state.result,state.appeals_pending]);
  if ($('result-comparison').dataset.signature===signature) return;
  $('result-comparison').dataset.signature=signature;
  $('result-comparison').replaceChildren();
  const participants=[...state.players].sort((a,b)=>Number(b.id===state.me)-Number(a.id===state.me));
  for(const player of participants){
    const item=document.createElement('div');item.className='result-player'+(state.result?.winner===player.id?' is-winner':'');
    const name=document.createElement('strong');name.textContent=player.id===state.me?'Вы':player.name;
    const score=document.createElement('div');score.className='result-number';score.setAttribute('aria-label',`Оценка за раунд: ${player.score.score} из 10`);score.textContent=player.score.score;const scale=document.createElement('span');scale.textContent=' / 10';score.append(scale);
    const detail=document.createElement('p');detail.className='result-adjustment';const adjustments=[];const appealDrop=player.submissions.reduce((sum,submission)=>{const appeal=submission.appeal;return sum+(appeal?.status==='graded'&&typeof appeal.old_verdict==='number'&&typeof appeal.effective_verdict==='number'?Math.max(0,appeal.old_verdict-appeal.effective_verdict):0);},0);if(appealDrop)adjustments.push(`Апелляция: −${appealDrop} к оценке работы`);if(player.score.penalty)adjustments.push(`Повторные проверки: −${player.score.penalty}`);detail.textContent=adjustments.join(' · ');detail.hidden=!adjustments.length;
    const finish=document.createElement('p');finish.className='result-finish';finish.textContent=finishLabel(player).split(' · ')[0];finish.title=finishLabel(player);
    item.append(name,score,finish,detail);$('result-comparison').append(item);
  }
  const trophy=document.createElement('div');trophy.className='match-trophy';
  const prizeWinner=state.players.find(player=>player.id===state.result?.winner);const prizeCaption=prizeWinner?prizeWinner.id===state.me?'Ваш бутерброд':`Получает ${prizeWinner.name}`:'Без награды';trophy.setAttribute('aria-label',state.result?.winner?'Победителю — один бутерброд':'Раунд завершён');
  trophy.innerHTML=`<img class="sandwich-trophy" src="/static/sandwich.svg" alt=""><span class="trophy-caption">${prizeCaption}</span>`;
  $('result-comparison').append(trophy);
  const entryKey=`${state.code}:${state.round}`;if($('result-comparison').dataset.entryKey!==entryKey){$('result-comparison').dataset.entryKey=entryKey;if(!matchMedia('(prefers-reduced-motion: reduce)').matches)trophy.animate([{opacity:0,transform:'translateY(-8px) rotate(-5deg)'},{opacity:1,transform:'translateY(0) rotate(0)'}],{duration:520,easing:'cubic-bezier(.23,1,.32,1)'});}

}

function renderHistory(players = state.players, target = $("history")) {
  const currentRound=target === $('history');
  if(currentRound)players=players.filter(player=>state.phase==='finished'&&reviewTab==='opponent'?player.id!==state.me:player.id===state.me);
  const player=players[0];
  if(!player)return;
  if(currentRound){const signature=JSON.stringify([state.phase,state.closed_at,player.name,player.submissions]);if(signature===historySignature)return;historySignature=signature;}
  if(!player.submissions.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Решение не отправлено.';target.replaceChildren(empty);return;}
  const entries=player.submissions.map((submission,index)=>({id:submission.id,number:index+1,status:submission.status,verdict:submission.verdict,submittedAt:submission.submitted_at,submission}));
  window.mathAttempts.render(target,entries,{
    key:`${state.code}-${currentRound?state.round:entries[0].id}-${player.id}`,
    finished:!currentRound||state.phase==='finished',
    build(entry,content,toolbar){
      renderReviewEntry(entry.submission,content,toolbar,player,currentRound,!currentRound||state.phase==='finished');
    }
  });
}

function renderReviewEntry(submission,content,toolbar,player,currentRound,finished) {
  const attemptNumber=player.submissions.findIndex(item=>item.id===submission.id)+1;
  if(finished){
    const identity=document.createElement('strong');identity.className='selected-work-identity';identity.textContent=`Работа №${attemptNumber}`;toolbar.querySelector('.review-document-stamp').prepend(identity);
    if(submission.appeal){const appeal=submission.appeal;const chip=document.createElement('span');chip.className='appeal-state-chip';chip.dataset.status=appeal.status==='graded'?(appeal.effective_verdict>appeal.old_verdict?'accepted':'declined'):appeal.status;chip.setAttribute('role','status');chip.textContent=appeal.status==='pending'?'На апелляции':appeal.status==='failed'?'Ошибка апелляции':appeal.effective_verdict>appeal.old_verdict?'Апелляция принята':'Апелляция отклонена';
      const status=document.createElement('div');status.className='selected-work-status';status.append(chip);
      if(appeal.status==='graded'){const change=document.createElement('span');change.className='appeal-score-change';change.textContent=`${appeal.old_verdict} → ${appeal.effective_verdict} / 10`;status.append(change);}
      toolbar.append(status);
    }
  }
  const work=document.createElement('section');work.className='review-region review-work';
  if(finished){const title=document.createElement('h3');title.textContent=player.id===state.me?`Ваша работа №${attemptNumber}`:`Работа соперника №${attemptNumber}`;work.append(title);if(submission.appeal){const note=document.createElement('p');note.className='work-snapshot-note';note.textContent='Исходная отправленная работа. Именно к ней относится апелляция.';work.append(note);}}
  const proof=document.createElement('div');proof.className='rendered submitted-document';
  render(proof,submission.solution||'');window.appendSolutionImages(proof,submission.images||[]);work.append(proof);
  if(!finished){
    if(submission.error){const error=document.createElement('p');error.className='error';error.textContent=submission.error;content.append(error);}
    content.append(work);return;
  }
  const layout=document.createElement('div');layout.className='attempt-review-layout';layout.append(work);
  if(submission.grade||submission.error){
    const grading=document.createElement('section');grading.className='review-region review-grading';
    const heading=document.createElement('h3');heading.textContent='Почему такая оценка';grading.append(heading);
    const currentGrade=submission.appeal?.status==='graded'?(submission.appeal.grade || submission.grade):submission.grade;
    if(submission.appeal?.status==='graded'&&typeof submission.original_verdict==='number'){
      const original=document.createElement('p');original.className='grade-original-score';original.textContent=`После апелляции: ${submission.appeal.effective_verdict} из 10 · исходная оценка ${submission.original_verdict}`;grading.append(original);
    }
    if(submission.error){const error=document.createElement('p');error.className='error';error.textContent=submission.error;grading.append(error);}
    if(submission.grade){
      const reasoning=document.createElement('div');reasoning.className='rendered';render(reasoning,currentGrade.reasoning || submission.grade.reasoning);grading.append(reasoning);
      if(currentGrade.evidence&&currentGrade.evidence!==currentGrade.reasoning){const evidence=document.createElement('section');evidence.className='grade-evidence';const label=document.createElement('h4');label.textContent='Обоснование оценки';const body=document.createElement('div');body.className='rendered';render(body,currentGrade.evidence);evidence.append(label,body);grading.append(evidence);}
    }
    layout.append(grading);
  }
  content.append(layout);
  const appeal=buildAppealRegion(submission,player,currentRound);
  if(appeal){
    content.parentElement.append(appeal.region);
    const trigger=document.createElement('button');trigger.type='button';trigger.className='review-appeal-trigger';trigger.textContent=appeal.label;trigger.setAttribute('aria-controls',appeal.region.id);trigger.setAttribute('aria-expanded',String(!appeal.region.hidden));
    trigger.onclick=()=>{appeal.draft.open=!appeal.draft.open;appeal.region.hidden=!appeal.draft.open;trigger.setAttribute('aria-expanded',String(appeal.draft.open));if(appeal.draft.open){const target=appeal.region.querySelector('textarea')||appeal.region.querySelector('h3');target.focus({preventScroll:true});appeal.region.scrollIntoView({block:'start',behavior:'auto'});}};
    toolbar.append(trigger);
  }
}

function appealQuotaUsed(player) {
  const prefix=`${state.code}:${state.round}:`;
  return player.submissions.some(submission=>['pending','graded'].includes(submission.appeal?.status)) || [...appealRequests].some(key=>key.startsWith(prefix));
}

function buildAppealRegion(submission,player,currentRound) {
  if(currentRound&&state.phase!=='finished')return null;
  const appeal=submission.appeal;
  const canSubmit=currentRound&&!state.closed_at&&state.phase==='finished'&&player.id===state.me&&submission.appeal_eligible&&!appealQuotaUsed(player);
  if(!appeal&&!canSubmit)return null;
  const key=`${state.code}:${state.round}:${submission.id}`;
  let draft=appealDrafts.get(key);
  if(!draft){draft={reason:appeal?.reason||'',requestId:null,open:false};appealDrafts.set(key,draft);}
  const region=document.createElement('section');region.className='attempt-appeal-region';region.id=`appeal-region-${submission.id}`;region.hidden=!draft.open;
  const heading=document.createElement('h3');heading.id=`appeal-heading-${submission.id}`;heading.tabIndex=-1;heading.textContent=`Апелляция к работе №${player.submissions.findIndex(item=>item.id===submission.id)+1}`;region.setAttribute('aria-labelledby',heading.id);region.append(heading);const context=document.createElement('p');context.className='appeal-context';context.textContent=`Работа отправлена ${timeText(submission.submitted_at)}. Исходный текст показан в разделе работы выше.`;region.append(context);
  if(appeal?.reason&&!canSubmit){const argument=document.createElement('section');argument.className='appeal-argument';const label=document.createElement('h4');label.textContent=player.id===state.me?'Ваш аргумент':'Аргумент соперника';const reason=document.createElement('p');reason.textContent=appeal.reason;argument.append(label,reason);region.append(argument);}
  if(appeal){
    const decision=document.createElement('section');decision.className='appeal-decision';
    if(appeal.status==='graded'){const label=document.createElement('h4');label.textContent='Решение по апелляции';decision.append(label);}
    const status=document.createElement('p');status.className='appeal-status';status.setAttribute('role','status');
    if(appeal.status==='pending')status.textContent='Апелляция рассматривается. Итог раунда предварительный.';
    else if(appeal.status==='failed'){status.classList.add('error');status.textContent='Не удалось рассмотреть апелляцию. Оценка не изменилась, штрафа нет.';}
    else if(typeof appeal.old_verdict==='number')status.textContent=appeal.effective_verdict>appeal.old_verdict?`Оценка повышена: ${appeal.old_verdict} → ${appeal.effective_verdict} из 10.`:`Оценка не повышена: ${appeal.old_verdict} → ${appeal.effective_verdict} из 10. Снижение на 1 балл.`;
    else status.textContent='Апелляция рассмотрена.';
    decision.append(status);
    if(appeal.error){const error=document.createElement('p');error.className='muted';error.textContent=appeal.error;decision.append(error);}
    if(appeal.status==='graded' && submission.grade){const history=document.createElement('details');history.className='original-grade-history';const summary=document.createElement('summary');summary.textContent=`Исходная оценка: ${appeal.old_verdict} из 10`;const review=document.createElement('div');review.className='rendered';render(review,submission.grade.reasoning);history.append(summary,review);decision.append(history);}
    region.append(decision);
  }
  if(canSubmit){
    const form=document.createElement('form');form.className='appeal-form';
    const label=document.createElement('label');label.htmlFor=`appeal-reason-${submission.id}`;label.textContent='Почему оценку нужно повысить?';
    const reason=document.createElement('textarea');reason.id=label.htmlFor;reason.rows=3;reason.maxLength=5000;reason.required=true;reason.value=draft.reason;reason.placeholder='Укажите конкретный шаг решения или ошибку в разборе.';
    const warning=document.createElement('p');warning.className='appeal-warning';warning.id=`appeal-warning-${submission.id}`;warning.textContent='Одна апелляция на задачу за раунд. Если оценку не повысят — минус 1 балл, даже ниже нуля. Проверка оплачивается вашим ключом.';reason.setAttribute('aria-describedby',warning.id);
    const error=document.createElement('p');error.className='error';error.setAttribute('role','alert');
    const button=document.createElement('button');button.type='submit';button.textContent=appealRequests.has(key)?'Отправляется…':'Отправить апелляцию';button.disabled=appealRequests.has(key)||!draft.reason.trim()||!state.has_api_key;
    reason.addEventListener('input',()=>{if(draft.reason!==reason.value){draft.reason=reason.value;draft.requestId=null;}button.disabled=!reason.value.trim()||appealRequests.has(key)||!state.has_api_key;});
    const round=state.round;
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if(state.closed_at||state.phase!=='finished'||state.round!==round){error.textContent='Апелляция доступна после завершения раунда и всех проверок.';return;}
      if(appealRequests.has(key)||!reason.value.trim())return;
      if(appealQuotaUsed(me())){error.textContent='Апелляция на эту задачу уже использована или рассматривается.';return;}
      if(!state.has_api_key){error.textContent='Добавьте ключ OpenRouter в настройках.';return;}
      if(!draft.requestId||(appeal?.status==='failed'&&draft.requestId===appeal.request_id))draft.requestId=requestId();
      appealRequests.add(key);button.disabled=true;button.textContent='Отправляется…';reason.readOnly=true;error.textContent='';
      try{const next=await api(sessionPath(`/submissions/${encodeURIComponent(submission.id)}/appeal`),'POST',{round,request_id:draft.requestId,reason:reason.value.trim()});if(state.round===round){apply(next);document.getElementById(heading.id)?.focus({preventScroll:true});}}
      catch(failure){error.textContent=failure.message;if(failure.status===409)try{apply(await api(sessionPath()));}catch{}}
      finally{appealRequests.delete(key);button.disabled=!reason.value.trim()||!state.has_api_key;button.textContent='Отправить апелляцию';reason.readOnly=false;}
    });
    form.append(label,reason,warning,error,button);region.append(form);
  }
  const label=appeal?.status==='graded'?'Решение по апелляции':appeal?.status==='pending'?'Апелляция рассматривается':appeal?.status==='failed'&&canSubmit?'Повторить апелляцию':canSubmit?'Оспорить оценку':'Апелляция';
  return {region,draft,label};
}

function renderRounds() {
  const rounds=state.previous_rounds || [];
  $('round-history').hidden=!rounds.length;
  const signature=JSON.stringify(rounds);if(signature===roundHistorySignature)return;roundHistorySignature=signature;
  const list=$('round-history-list');list.replaceChildren();
  for(const round of [...rounds].reverse()){
    const link=document.createElement('a');link.className='round-history-link';link.href=`/s/${encodeURIComponent(code)}?round=${round.round}`;
    const title=document.createElement('strong');title.textContent=`Раунд ${round.round}`;
    const task=document.createElement('span');task.textContent=round.title;
    const score=document.createElement('span');score.textContent=state.players.map(player=>round.scores[player.id]).join(' : ');
    link.append(title,task,score);list.append(link);
  }
}

function renderChat() {
  const opponent=state.players.find(player=>player.id!==state.me);
  $('chat-title').textContent=opponent?.name || 'Чат дуэли';
  $('chat-room-status').textContent=state.closed_at?'Комната закрыта · история':`Раунд ${state.round}`;
  const signature=JSON.stringify({chat:state.chat,opponent:opponent?.id,closed:state.closed_at,round:state.round});
  if(signature===chatSignature)return;
  const previous=chatSignature?JSON.parse(chatSignature).chat:[];
  chatSignature=signature;
  const container=$('chat-messages');
  const atBottom=container.scrollHeight-container.scrollTop-container.clientHeight<60;
  const scroll=container.scrollTop;
  const content=document.createDocumentFragment();
  let group=null,lastAuthor=null,lastRound=null;
  for(const message of state.chat){
    if(message.kind==='solution'){
      const event=document.createElement('details');event.className='chat-event';
      const label=document.createElement('summary');label.textContent=`Эталонное решение · раунд ${message.round}`;
      const body=document.createElement('div');body.className='rendered';render(body,message.text);event.append(label,body);content.append(event);group=null;lastAuthor=null;continue;
    }
    if(!group||lastAuthor!==message.player_id||lastRound!==message.round){
      group=document.createElement('section');group.className='chat-group'+(message.player_id===state.me?' is-own':' is-other');
      if(message.player_id!==state.me){const sender=document.createElement('span');sender.className='chat-sender';sender.textContent=state.players.find(player=>player.id===message.player_id)?.name||'Соперник';group.append(sender);}
      content.append(group);lastAuthor=message.player_id;lastRound=message.round;
    }
    group.querySelector('time')?.remove();
    const bubble=document.createElement('p');bubble.className='chat-bubble';bubble.textContent=message.text;
    const time=document.createElement('time');time.dateTime=new Date(message.sent_at*1000).toISOString();time.textContent=new Date(message.sent_at*1000).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',hour12:false});time.title=new Date(message.sent_at*1000).toLocaleString('ru-RU');group.append(bubble,time);
  }
  if(!state.chat.length){const empty=document.createElement('p');empty.className='chat-empty';empty.textContent=state.closed_at?'Сообщений пока нет.':opponent?'Сообщений пока нет. Начните разговор.':'Чат появится здесь, когда присоединится соперник.';content.append(empty);}
  container.replaceChildren(content);
  container.scrollTop=atBottom?container.scrollHeight:scroll;
  if(previous.length&&state.chat.length>previous.length&&state.chat.at(-1).player_id!==state.me)$('chat-announcement').textContent='Новое сообщение от соперника.';
}

function layoutChat(focusComposer=false) {
  const panel=$('chat-panel'),dialog=$('chat-dialog'),dock=$('chat-dock');
  const focused=panel.contains(document.activeElement)?document.activeElement:null;
  const selection=focused=== $('chat-input')?[focused.selectionStart,focused.selectionEnd]:null;
  const scroll=$('chat-messages').scrollTop;
  movingChat=true;
  if(chatOpen&&mobileChat.matches){
    dock.hidden=true;dialog.append(panel);document.body.dataset.chat='mobile';
    if(!dialog.open)dialog.showModal();
  }else{
    if(dialog.open)dialog.close();
    dock.append(panel);dock.hidden=!chatOpen;
    if(chatOpen){document.body.dataset.chat='docked';dock.style.setProperty('--chat-top',`${Math.max(96,dock.getBoundingClientRect().top)+16}px`);}else delete document.body.dataset.chat;
  }
  movingChat=false;
  $('open-chat').setAttribute('aria-expanded',String(chatOpen));
  $('chat-messages').scrollTop=scroll;
  if(chatOpen&&(focused||focusComposer)){const target=focused||$('chat-input');if(!target.disabled){target.focus({preventScroll:true});if(selection)target.setSelectionRange(...selection);}}
}

function openChat() {
  chatOpen=true;layoutChat(true);
  if(!chatOpenedBefore){$('chat-messages').scrollTop=$('chat-messages').scrollHeight;chatOpenedBefore=true;}
}
function closeChat() {
  chatOpen=false;layoutChat();$('open-chat').focus({preventScroll:true});
}

async function saveDraft() {
  clearTimeout(draftTimer);
  if (savePromise) return savePromise;
  if (!draftDirty || draftConflict || !state || state.closed_at || state.phase === "lobby") return;
  const savingRound = state.round;
  savePromise = (async () => {
    while (draftDirty && !draftConflict && !state.closed_at && state.phase !== "lobby" && state.round === savingRound) {
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
          try{apply(await api(sessionPath()));}catch{}
          if(state.closed_at){backupDraft();return;}
          draftConflict = true;
          $("draft-conflict").hidden = false;
          notice(error.message, true);
        } else {
          notice("Черновик сохранён на устройстве. После восстановления связи отправим его на сервер.", true);
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
    if (draftDirty && !draftConflict && !savePromise && !state.closed_at) saveDraft();
  } catch (error) {
    $("connection").textContent = "Переподключение…";
    if (error.status === 401 || error.status === 403) {
      $("session").hidden = true;
      $("landing").hidden = false;
      $("join-code").value = code;
      document.querySelector('[data-home-mode="join"]').click();
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
  history.replaceState(null, "", `/s/${code}${location.search}`);
  apply(next);
  pollTimer = setTimeout(poll, 1200);
}

async function action(callback) {
  if (actionBusy || state?.closed_at) return;
  actionBusy = true;
  controls();
  try { await callback(); } catch (error) { notice(error.message, true); if(error.status===409)try{apply(await api(sessionPath()));}catch{} }
  finally { actionBusy = false; controls(); }
}

function hasUnsubmittedChanges() {
  if (!state || !solutionImages) return false;
  const solution = $("solution").value;
  const images = solutionImages.value;
  if (!solution.trim() && !images.length) return false;
  const latest = me().submissions.at(-1);
  if (!latest) return true;
  if (acceptedPayload?.submissionId === latest.id) return acceptedPayload.solution !== solution || acceptedPayload.images.length !== images.length || images.some((image,index)=>image.name !== acceptedPayload.images[index]?.name || image.data_url !== acceptedPayload.images[index]?.data_url);
  return latest.solution !== solution || !!images.length;
}

function persistImageDraft() {
  return window.mathDrafts.put(draftKey(), {images:solutionImages.value, accepted:acceptedPayload});
}

async function submitSolution(finalize = false) {
  if ($("submit").disabled) return;
  if(!state.has_api_key){keyPrompted=true;controls();$('submission-hint').textContent='Для проверки нужен ключ OpenRouter. Добавьте его в настройках аккаунта.';window.mathAccount.open({section:'key',reason:'Добавьте ключ OpenRouter для проверки решения.'});return;}
  await action(async () => {
    const solution = $("solution").value;
    const images = solutionImages.value;
    saveDraft();
    if (!pendingRequest || pendingRequest.solution !== solution || pendingRequest.images.length !== images.length || pendingRequest.images.some((image, index) => image !== images[index])) {
      pendingRequest = { solution, images, request_id: requestId(), round: state.round };
    }
    const next = await api(sessionPath("/submissions"), "POST", {...pendingRequest, finalize});
    const accepted = next.players.find(player=>player.id===next.me).submissions.find(submission=>submission.request_id===pendingRequest.request_id) || next.players.find(player=>player.id===next.me).submissions.at(-1);
    acceptedPayload = {submissionId:accepted.id, solution, images};
    pendingRequest = null;
    apply(next);
    await persistImageDraft().catch(()=>{imageBackupFailed=true;});
    notice("Решение принято. Проверка идёт в фоне.");
  });
}

async function withdrawReadyForSelection() {
  if(!state || state.phase !== 'lobby' || !me().ready || readinessWithdrawal)return readinessWithdrawal;
  const round=state.round;
  readinessWithdrawal=api(sessionPath('/ready'),'PUT',{ready:false,round}).then(next=>{if(state.round===round)apply(next);}).catch(error=>{notice(error.message,true);}).finally(()=>{readinessWithdrawal=null;controls();});
  controls();
  return readinessWithdrawal;
}

async function init() {
  document.addEventListener("keydown",event=>{if(["Tab","Enter"," "].includes(event.key))keyboardNavigation=true;});
  document.addEventListener("pointerdown",()=>{keyboardNavigation=false;});
  if (!render) { notice("Не удалось загрузить отображение формул. Проверьте соединение и обновите страницу.", true); return; }
  solutionImages = new window.SolutionImages($("solution-images"), $("image-attachments"), $("solution"), () => {
    controls();
    if (state && !restoringImages) persistImageDraft().then(() => {imageBackupFailed=false; controls();}).catch(() => {imageBackupFailed=true; controls();});
  }, notice);
  solutionImages.setDisabled(true);
  $("connect-key").onclick = () => window.mathAccount.open({section:"key",reason:"Добавьте ключ OpenRouter для проверки решения."});
  $('open-chat').setAttribute('aria-controls','chat-panel');
  $('open-chat').setAttribute('aria-expanded','false');
  $('open-chat').onclick=()=>chatOpen?closeChat():openChat();
  $('close-chat').onclick=closeChat;
  $('chat-dialog').addEventListener('cancel',event=>{event.preventDefault();closeChat();});
  mobileChat.addEventListener('change',()=>layoutChat());
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&chatOpen&&!mobileChat.matches&&!event.defaultPrevented&&!document.querySelector('dialog[open]')){event.preventDefault();closeChat();}});
  $('chat-input').addEventListener('input',controls);
  $('chat-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();$('chat-form').requestSubmit();}});
  document.querySelectorAll('[data-review]').forEach(button=>button.addEventListener('click',()=>{reviewTab=button.dataset.review;document.querySelectorAll('[data-review]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));historySignature="";if(state)apply(state);}));
  document.querySelectorAll('[data-home-mode]').forEach(button=>button.onclick=()=>{$('create-form').hidden=button.dataset.homeMode!=='create';$('join-disclosure').hidden=button.dataset.homeMode!=='join';document.querySelectorAll('[data-home-mode]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));});
  document.querySelectorAll('[data-lobby-mode]').forEach(button=>button.onclick=()=>{
    lobbyMode=button.dataset.lobbyMode;
    apply(state);
    if(lobbyMode==='custom')$('custom-task-dialog').showModal();
    if(lobbyMode==='random' && (state.source!=='bank' || state.topic))action(async()=>{apply(await api(sessionPath('/topic'),'PUT',{topic:null,round:state.round}));});
    else withdrawReadyForSelection();
  });
  $('edit-custom-task').onclick=()=>$('custom-task-dialog').showModal();
  $('close-custom-task').onclick=()=>$('custom-task-dialog').close();
  $('lobby-topic').addEventListener('change',()=>{if($('lobby-topic').value)$('topic-form').requestSubmit();});
  $("create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    action(async () => {
      if (!window.mathAccount.user) { window.mathAccount.onSignedIn = () => $("create-form").requestSubmit(); window.mathAccount.open(); return; }
      enter(await api("/api/sessions", "POST", {}));
      notice("Дуэль создана. Отправьте приглашение другу.");
    });
  });
  $("join-form").addEventListener("submit", (event) => {
    event.preventDefault();
    action(async () => {
      if (!window.mathAccount.user) {window.mathAccount.onSignedIn = () => $("join-form").requestSubmit(); window.mathAccount.open(); return;}
      const raw = $("join-code").value.trim();
      const inviteCode = (raw.includes("/") ? new URL(raw, location.origin).pathname.split("/").filter(Boolean).pop() : raw).toUpperCase();
      enter(await api(`/api/sessions/${encodeURIComponent(inviteCode)}/join`, "POST", { name: window.mathAccount.user.display_name }));
      notice("Вы присоединились к дуэли.");
    });
  });
  async function copyInvitation(){
    clearTimeout(inviteFeedbackTimer);
    try{await navigator.clipboard.writeText(`${location.origin}/s/${code}`);$('invite-feedback').textContent='Ссылка скопирована. Отправьте её другу.';$('copy-lobby-invite').textContent='Скопировано';if(state.phase!=='lobby')notice('Приглашение скопировано.');}
    catch{$('invite-url').focus();$('invite-url').select();$('invite-feedback').textContent='Скопируйте выделенную ссылку.';}
    inviteFeedbackTimer=setTimeout(()=>{inviteFeedbackTimer=null;$('copy-lobby-invite').textContent='Скопировать ссылку';if(state)apply(state);},4000);
  }
  $('close-room').addEventListener('click',()=>{if(state.me!==state.host||state.closed_at)return;$('close-room-error').textContent='';$('close-room-dialog').showModal();$('cancel-close-room').focus();});
  function cancelRoomClose(){if(actionBusy)return;$('close-room-dialog').close();$('close-room').focus();}
  $('cancel-close-room').addEventListener('click',cancelRoomClose);
  $('dismiss-close-room').addEventListener('click',cancelRoomClose);
  $('close-room-dialog').addEventListener('cancel',event=>{if(actionBusy)event.preventDefault();});
  $('close-room-form').addEventListener('submit',async event=>{
    event.preventDefault();if(actionBusy||state.closed_at||state.me!==state.host)return;
    actionBusy=true;controls();$('confirm-close-room').disabled=true;$('cancel-close-room').disabled=true;$('dismiss-close-room').disabled=true;
    try{await saveDraft();if(draftDirty)backupDraft();const next=await api(sessionPath('/close'),'POST',{round:state.round});$('close-room-dialog').close();apply(next);notice('Комната закрыта.');}
    catch(error){$('close-room-error').textContent=error.message;if(error.status===409)try{apply(await api(sessionPath()));}catch{}}
    finally{actionBusy=false;controls();$('confirm-close-room').disabled=false;$('cancel-close-room').disabled=false;$('dismiss-close-room').disabled=false;}
  });
  $('copy-invite').addEventListener('click',copyInvitation);
  $('copy-lobby-invite').addEventListener('click',copyInvitation);
  $('invite-url').addEventListener('click',event=>event.target.select());
  $("topic-form").addEventListener("submit", event => {event.preventDefault(); action(async () => {apply(await api(sessionPath('/topic'),'PUT',{topic:$('lobby-topic').value,round:state.round}));notice('Тема обновлена. Подтвердите готовность заново.');});});
  $("ready").addEventListener("click", () => action(async () => {
    apply(await api(sessionPath("/ready"), "PUT", { ready: !me().ready, round: state.round }));
  }));
  $("rematch").addEventListener("click", () => action(async () => {
    apply(await api(sessionPath("/rematch"), "POST", { round: state.round }));
  }));
  function customEdited(){const wasDirty=customProblemDirty;customProblemDirty=true;controls();if(!wasDirty)withdrawReadyForSelection();}
  customProblemForm=window.mathProblemForm($('duel-problem-fields'),{prefix:'duel-custom',fileId:'next-problem-file',onChange:customEdited});
  // The hidden serialized field is retained for importing older local QA fixtures.
  $('next-problem-json').addEventListener('input',()=>{try{customProblemForm.fill(JSON.parse($('next-problem-json').value));}catch{}customEdited();});
  $('next-problem-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const problem=customProblemForm.get();const next=await api(sessionPath('/problem'),'PUT',{problem,round:state.round});customProblemDirty=false;apply(next);$('custom-task-dialog').close();notice('Задача обновлена. Подтвердите готовность заново.');});});
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
    const changed = hasUnsubmittedChanges();
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
    if(state.closed_at||chatSending)return;
    const sourceValue=$("chat-input").value;
    const text = sourceValue.trim();
    if(!text)return;
    $("chat-error").textContent="";
    const button = event.currentTarget.querySelector("button");
    chatSending=true;button.disabled = true;button.setAttribute("aria-busy","true");
    try {
      apply(await api(sessionPath("/chat"), "POST", { text }));
      if ($("chat-input").value === sourceValue) $("chat-input").value = "";
    } catch (error) { $("chat-error").textContent=error.message;if(error.status===409)try{apply(await api(sessionPath()));}catch{} }
    finally { chatSending=false;button.removeAttribute("aria-busy");controls(); }
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
  window.addEventListener('accountauthenticated', async () => {if (code) await poll(); notice('Вы вошли. Можно продолжить.');});
  await window.mathAccount.ready;
  try {
    const data = await api("/api/sessions");

    $("recent").hidden = !data.sessions.length;
    for (const session of data.sessions) {
      const link = document.createElement("a");
      link.className = "recent-link";
      link.href = `/s/${session.code}`;
      const name=document.createElement('strong');name.textContent=session.names.join(' и ') || 'Ждём соперника';
      const meta=document.createElement('div');meta.className='recent-meta';const phase=document.createElement('span');phase.textContent=session.closed_at?'Комната закрыта':{lobby:'Ожидание друга',active:'Идёт раунд',grading:'Проверка решений',finished:'Раунд завершён'}[session.phase] || session.phase;const arrow=document.createElement('span');arrow.textContent=session.closed_at?'Посмотреть':'Продолжить →';meta.append(phase,arrow);link.append(name,meta);
      const row=document.createElement('div');row.className='recent-room';
      const hide=document.createElement('button');hide.type='button';hide.className='quiet hide-recent-room';hide.textContent='Убрать из списка';hide.setAttribute('aria-label',`Убрать из списка комнату ${session.code}`);
      hide.onclick=async()=>{
        hide.disabled=true;
        try{
          await api(`/api/sessions/${encodeURIComponent(session.code)}/visibility`,'PUT',{hidden:true});
          const next=row.nextSibling;row.remove();$('recent').hidden=!$('recent-list').children.length;
          let feedback=$('recent-feedback');if(!feedback){feedback=document.createElement('div');feedback.id='recent-feedback';feedback.className='recent-feedback';feedback.setAttribute('role','status');$('recent').before(feedback);}
          const message=document.createElement('span');message.textContent='Комната убрана из вашего списка.';
          const undo=document.createElement('button');undo.type='button';undo.className='text-button';undo.textContent='Вернуть';
          undo.onclick=async()=>{undo.disabled=true;try{await api(`/api/sessions/${encodeURIComponent(session.code)}/visibility`,'PUT',{hidden:false});$('recent-list').insertBefore(row,next?.isConnected?next:null);$('recent').hidden=false;hide.disabled=false;feedback.replaceChildren();hide.focus();}catch(error){notice(error.message,true);undo.disabled=false;}};
          feedback.replaceChildren(message,undo);
        }catch(error){notice(error.message,true);hide.disabled=false;}
      };
      row.append(link,hide);$('recent-list').append(row);
    }
    $("connection").textContent = "На связи";
    if (code) await poll(); else $("landing").hidden = false;
  } catch (error) { $("landing").hidden = false; notice(error.message, true); }
}

init();
