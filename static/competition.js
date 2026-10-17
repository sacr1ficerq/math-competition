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
  $('lobby-task-summary').hidden=state.me === state.host;
  $('task-selection-title').textContent=state.round === 1 ? 'Задача дуэли' : 'Следующая задача';
  const selectedTopic=state.available_topics?.find(topic=>topic.slug===state.topic);
  $('lobby-task-summary').textContent=savedTaskMode === 'custom' ? 'Своя задача' : savedTaskMode === 'topic' ? `Тема: ${selectedTopic?.label || state.topic}` : 'Случайная новая задача из банка';
  document.querySelectorAll('[data-lobby-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.lobbyMode===lobbyMode)));
  const topicsSignature=JSON.stringify(state.available_topics || []);
  if(topicsSignature !== lobbyTopicsSignature){lobbyTopicsSignature=topicsSignature;const current=$('lobby-topic').value;$('lobby-topic').replaceChildren(new Option('Выберите тему',''));for(const topic of state.available_topics || [])$('lobby-topic').append(new Option(topic.label,topic.slug));$('lobby-topic').value=current;}
  if(document.activeElement !== $('lobby-topic'))$('lobby-topic').value=state.source === 'bank' ? state.topic || '' : '';
  $("lobby").hidden = state.phase !== "lobby";
  const waitingForOpponent=state.players.length < 2;
  $('lobby-title').textContent=waitingForOpponent?'Пригласите соперника':state.round===1?'Можно начинать':`Раунд ${state.round}`;
  $('lobby-description').textContent=waitingForOpponent?'Отправьте ссылку другу — он присоединится к этой комнате.':'Условие откроется одновременно, когда вы оба будете готовы.';
  $('invite-url').value=`${location.origin}/s/${state.code}`;
  $('copy-lobby-invite').classList.toggle('primary',waitingForOpponent);
  $('copy-lobby-invite').classList.toggle('invite-copy-secondary',!waitingForOpponent);
  if(!inviteFeedbackTimer || !waitingForOpponent)$('invite-feedback').textContent=waitingForOpponent?'Ждём второго игрока.':'Вы оба в комнате. Подтвердите готовность.';
  $('lobby').dataset.players=waitingForOpponent?'one':'two';
  $('lobby-readiness').hidden=waitingForOpponent;
  $('lobby-model-state').textContent=`Проверка: ${state.model}`;
  document.body.dataset.phase=state.phase;
  $("next-problem").hidden = state.phase !== "lobby" || state.me !== state.host || lobbyMode !== "custom";
  $("topic-availability").textContent = selectedTopic ? `Новых задач для вас обоих: ${selectedTopic.unseen_count}.` : "Выберите тему перед подтверждением готовности.";
  window.mathUI.syncPickers();
  $("arena").hidden = state.phase === "lobby" || state.phase === "finished";
  $("histories").hidden = state.phase === "lobby" || (state.phase === "finished" && reviewTab === "reference") || (state.phase !== "finished" && !player.submissions.length);
  $("ready").textContent = player.ready ? "Не готов" : "Готов";
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
      render($("reference"), state.problem.reference_solution);
    }
  }
  $("result").hidden = state.phase !== "finished";
  $("revealed").hidden = state.phase !== "finished" || reviewTab !== "reference";
  $("feedback-hint").textContent = "";
  if (state.result) {
    const winner = state.players.find((p) => p.id === state.result.winner);
    $("result-title").textContent = state.appeals_pending ? "Результат уточняется" : winner ? winner.id === state.me ? "Ваша победа" : `${winner.name} побеждает` : "Ничья";
    $("result-reason").textContent = state.appeals_pending ? "Предварительный результат: рассматривается апелляция. Итог и счёт серии могут измениться." : resultReason();
    $("result-reason").hidden = !$("result-reason").textContent;
  }
  const historyHost = state.phase === "finished" ? $("result-history-host") : $("active-history-host");
  if ($("histories").parentElement !== historyHost) historyHost.append($("histories"));
  renderResultComparison();
  renderHistory();
  renderRounds();
  renderChat();
  controls();
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
  const signature = JSON.stringify([state.phase, state.players.map((p) => [p.id, p.name, p.ready, p.finalized, p.finalized_at, p.score, p.wins])]);
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
    label.textContent = state.phase === "lobby" ? p.ready ? "Готов" : "Не готов" : p.finalized ? state.phase === "finished" ? "Раунд завершён" : `Завершил в ${timeText(p.finalized_at)}` : "Решает";
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
  $("player-cards").classList.toggle("scoreboard",state.phase!=="lobby");
  if(state.phase!=="lobby"){
    const sides=[...cards.children];
    const tally=document.createElement("div");tally.className="match-tally";
    sides.forEach((card,index)=>{card.classList.add("match-player");card.querySelector(".player-initials")?.remove();const wins=card.querySelector(".win-count");if(wins){wins.setAttribute("aria-label",`Бутерброды ${state.players[index].name}: ${state.players[index].wins}`);tally.append(wins);}if(!index){const colon=document.createElement("span");colon.className="tally-colon";colon.textContent=":";colon.setAttribute("aria-hidden","true");tally.append(colon);}});
    cards.insertBefore(tally,sides[1]);
  }else{
    const axis=document.createElement("span");axis.className="duel-axis";axis.setAttribute("aria-hidden","true");axis.textContent="⋈";cards.insertBefore(axis,cards.children[1]);
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
  $('ready').disabled=actionBusy || !!readinessWithdrawal || state.players.length < 2 || customPending || topicPending || randomPending;
  if(customPending)$('lobby-hint').textContent='Добавьте и примените свою задачу перед стартом.';
  if(topicPending)$('lobby-hint').textContent='Выберите тему задачи перед стартом.';
  if(randomPending)$('lobby-hint').textContent='Не удалось применить выбор. Выберите «Случайная» ещё раз.';
  $("rematch").disabled = actionBusy || state.phase !== "finished" || !!state.appeals_pending;
  $("rematch").title = state.appeals_pending ? "Дождитесь рассмотрения апелляции" : "";
  let hint = "";
  if (state.phase === "grading") hint = "Ждём окончания проверки…";
  else if (p.finalized && pending) hint = `Завершено · проверяется попыток: ${pending}. Оценка предварительная.`;
  else if (p.finalized) hint = p.submissions.length ? "Вы завершили решение." : "Вы завершили раунд без отправленного решения.";
  else if (pending) hint = `Проверяется попыток: ${pending}. Можно продолжать решать.`;
  else if (!state.has_api_key && keyPrompted) hint = "Для проверки нужен ключ OpenRouter. Решение и черновик сохраняются.";
  else if (!p.submissions.length) hint = "Решение ещё не отправлено на проверку.";
  $("submission-hint").textContent = hint;
  $("connect-key").hidden = !keyPrompted || state.has_api_key || state.phase !== "active" || p.finalized;
  $("draft-status").textContent = imageBackupFailed ? "Изображения не сохранены локально" : restoringImages ? "Восстановление…" : draftConflict ? "Конфликт черновиков" : savePromise ? "Сохраняется…" : draftDirty ? "Не сохранено" : "Сохранено";
  $("deadline").hidden = p.deadline === null || p.finalized || state.phase === "finished";
  if (!$("deadline").hidden) {
    const remaining = Math.max(0, Math.ceil(p.deadline - now()));
    $("deadline").textContent = remaining ? `Соперник завершил. Осталось ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "Время истекло. Завершаем раунд…";
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
  const signature=JSON.stringify([state.players.map(player=>[player.id,player.score,player.finalized_at]),state.result]);
  if ($('result-comparison').dataset.signature===signature) return;
  $('result-comparison').dataset.signature=signature;
  $('result-comparison').replaceChildren();
  for(const player of [...state.players].sort((a,b)=>Number(state.result?.winner===b.id)-Number(state.result?.winner===a.id))){const item=document.createElement('div');item.className='result-player'+(state.result?.winner===player.id?' is-winner':'');const rank=document.createElement('span');rank.className='podium-rank';rank.textContent=state.result?.winner ? state.result.winner===player.id?'1':'2':'=';item.append(rank);const name=document.createElement('strong');name.textContent=player.id===state.me?'Вы':player.name;const score=document.createElement('div');score.className='result-number';score.textContent=player.score.score;const scale=document.createElement('span');scale.textContent=' / 10';score.append(scale);const detail=document.createElement('p');detail.textContent=player.score.penalty?`Оценка ${player.score.best} − штраф ${player.score.penalty} = ${player.score.score}`:"Без штрафа";const finish=document.createElement("p");finish.textContent=finishLabel(player);const reward=document.createElement('span');reward.className='podium-reward';reward.textContent=state.result?.winner===player.id?'+1 🥪':'';item.append(name,score,detail,finish,reward);$('result-comparison').append(item);}
  const entryKey=`${state.code}:${state.round}`;if($('result-comparison').dataset.entryKey!==entryKey){$('result-comparison').dataset.entryKey=entryKey;if(!matchMedia('(prefers-reduced-motion: reduce)').matches)$('result-comparison').animate([{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}],{duration:260,easing:'cubic-bezier(.23,1,.32,1)'});}
}

function renderHistory(players = state.players, target = $("history")) {
  const currentRound=target === $('history');
  if(currentRound)players=players.filter(player=>state.phase==='finished'&&reviewTab==='opponent'?player.id!==state.me:player.id===state.me);
  const player=players[0];
  if(!player)return;
  if(currentRound){const signature=JSON.stringify([state.phase,player.name,player.submissions]);if(signature===historySignature)return;historySignature=signature;}
  if(!player.submissions.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Решение не отправлено.';target.replaceChildren(empty);return;}
  const entries=player.submissions.map((submission,index)=>({id:submission.id,number:index+1,status:submission.status,verdict:submission.verdict,submittedAt:submission.submitted_at,submission}));
  window.mathAttempts.render(target,entries,{
    key:`${state.code}-${currentRound?state.round:entries[0].id}-${player.id}`,
    finished:!currentRound||state.phase==='finished',
    build(entry,content,toolbar){
      const submission=entry.submission;
      const finished=!currentRound||state.phase==='finished';
      const section=(title,text)=>window.mathAttempts.section(content,title,text,render,{folded:title==='Разбор апелляции'});
      appendAppeal(content,submission,player,currentRound,section);
      const appealForm=content.querySelector('.appeal-form-panel');
      if(appealForm){
        const trigger=document.createElement('button');trigger.type='button';trigger.className='review-appeal-trigger';trigger.textContent='Оспорить';
        appealForm.id=`appeal-panel-${submission.id}`;appealForm.dataset.linked='true';trigger.setAttribute('aria-controls',appealForm.id);trigger.setAttribute('aria-expanded',String(appealForm.open));
        trigger.onclick=()=>{appealForm.open=!appealForm.open;trigger.setAttribute('aria-expanded',String(appealForm.open));if(appealForm.open){appealForm.querySelector('textarea')?.focus({preventScroll:true});toolbar.scrollIntoView({block:'start',behavior:'auto'});}};toolbar.append(trigger);
      }
      if(submission.error){const error=document.createElement('p');error.className='error';error.textContent=submission.error;content.append(error);}
      if(finished&&submission.grade){section('Разбор',submission.grade.reasoning);if(submission.grade.evidence&&submission.grade.evidence!==submission.grade.reasoning)section('Обоснование',submission.grade.evidence);}
      if(submission.solution!==undefined){
        const proof=document.createElement('div');proof.className='rendered submitted-document';
        if(finished&&submission.grade){const title=document.createElement('h3');title.textContent='Отправленное решение';content.append(title);proof.classList.add('after-review');}
        render(proof,submission.solution||'');window.appendSolutionImages(proof,submission.images||[]);content.append(proof);
      }
    }
  });
}

function appendAppeal(feedback, submission, player, currentRound, section) {
  if(currentRound && state.phase !== "finished")return;
  const appeal = submission.appeal;
  if (appeal) {
    const review = document.createElement("div");
    review.className = "appeal-review";
    const label = document.createElement("p");
    label.className = "appeal-status";
    label.setAttribute("role", "status");
    if (appeal.status === "pending") label.textContent = "Апелляция рассматривается… Итог раунда пока предварительный.";
    else if (appeal.status === "failed") {label.classList.add("error"); label.textContent = "Не удалось рассмотреть апелляцию. Оценка не изменилась, штрафа нет. Можно повторить.";}
    else if (typeof appeal.old_verdict !== "number") label.textContent = "Апелляция рассмотрена. Подробности откроются после раунда.";
    else label.textContent = appeal.effective_verdict > appeal.old_verdict
      ? `Апелляция принята: ${appeal.old_verdict} → ${appeal.effective_verdict} / 10.`
      : `Оценка не повышена: ${appeal.old_verdict} → ${appeal.effective_verdict} / 10. Применено снижение на 1 балл.`;
    review.append(label);
    if (appeal.reason) {const reason=document.createElement("p");reason.className="appeal-reason";reason.textContent=`Основание: ${appeal.reason}`;review.append(reason);}
    if (appeal.error) {const error=document.createElement("p");error.className="muted";error.textContent=appeal.error;review.append(error);}
    feedback.append(review);
    if (appeal.grade) section("Разбор апелляции", `${appeal.grade.reasoning}\n\n### Обоснование\n\n${appeal.grade.evidence}`);
  }
  if (!currentRound || state.phase !== "finished" || player.id !== state.me || !submission.appeal_eligible) return;
  const key = `${state.code}:${state.round}:${submission.id}`;
  let draft = appealDrafts.get(key);
  if (!draft) {draft={reason:appeal?.reason || "", requestId:null, open:false};appealDrafts.set(key,draft);}
  const disclosure = document.createElement("details");
  disclosure.className="appeal-form-panel";
  disclosure.open=draft.open;
  const heading=document.createElement("summary");heading.textContent=appeal?.status === "failed" ? "Повторить апелляцию" : "Оспорить оценку";
  disclosure.append(heading);
  disclosure.addEventListener("toggle",()=>{draft.open=disclosure.open;});
  const form=document.createElement("form");
  const label=document.createElement("label");label.htmlFor=`appeal-reason-${submission.id}`;label.textContent="Почему оценку нужно повысить?";
  const reason=document.createElement("textarea");reason.id=label.htmlFor;reason.rows=3;reason.maxLength=5000;reason.required=true;reason.value=draft.reason;reason.placeholder="Укажите конкретный шаг решения или ошибку в разборе.";
  const warning=document.createElement("p");warning.className="appeal-warning";warning.id=`appeal-warning-${submission.id}`;warning.textContent="Одна апелляция на оценку. Если её не повысят — минус 1 балл, даже ниже нуля. Проверка оплачивается вашим ключом.";
  reason.setAttribute("aria-describedby",warning.id);
  const error=document.createElement("p");error.className="error";error.setAttribute("role","alert");
  const button=document.createElement("button");button.type="submit";button.textContent=appealRequests.has(key) ? "Отправляется…" : "Отправить апелляцию";button.disabled=appealRequests.has(key) || !draft.reason.trim() || !state.has_api_key;
  reason.addEventListener("input",()=>{if(draft.reason!==reason.value){draft.reason=reason.value;draft.requestId=null;}button.disabled=!reason.value.trim() || appealRequests.has(key) || !state.has_api_key;});
  const round=state.round;
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    if(state.phase !== "finished" || state.round !== round){error.textContent="Апелляция доступна после завершения раунда и всех проверок.";return;}
    if(appealRequests.has(key) || !reason.value.trim()) return;
    if(!state.has_api_key){error.textContent="Сначала подключите OpenRouter в настройках.";return;}
    if(!draft.requestId || (appeal?.status === "failed" && draft.requestId === appeal.request_id)) draft.requestId=requestId();
    appealRequests.add(key);button.disabled=true;button.textContent="Отправляется…";reason.readOnly=true;error.textContent="";
    try {
      const next=await api(sessionPath(`/submissions/${encodeURIComponent(submission.id)}/appeal`),"POST",{round,request_id:draft.requestId,reason:reason.value.trim()});
      if(state.round===round) {apply(next);notice("Апелляция принята. Дождитесь пересмотра оценки.");}
    } catch(failure) {error.textContent=failure.message;}
    finally {appealRequests.delete(key);button.disabled=!reason.value.trim() || !state.has_api_key;button.textContent="Отправить апелляцию";reason.readOnly=false;}
  });
  form.append(label,reason,warning,error,button);disclosure.append(form);feedback.append(disclosure);
}

function renderRounds() {
  const rounds = state.previous_rounds;
  $("round-history").hidden = !rounds.length;
  const signature = JSON.stringify(rounds);
  if (signature === roundHistorySignature) return;
  roundHistorySignature = signature;
  const list = $("round-history-list");
  const navigation=document.createElement('div');navigation.className='timeline-tabs';navigation.setAttribute('role','group');navigation.setAttribute('aria-label','Выбрать раунд');
  const detail=document.createElement('div');detail.className='timeline-detail';
  const cache=new Map();let selected=null;
  async function selectRound(round,button){
    selected=round.round;
    navigation.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
    detail.textContent='Загрузка раунда…';
    try {
      const archived=cache.get(round.round) || await api(sessionPath(`/rounds/${round.round}`));cache.set(round.round,archived);
      if(selected!==round.round)return;
      detail.replaceChildren();const heading=document.createElement('h3');heading.textContent=round.title;detail.append(heading);
      const reason=document.createElement('p');reason.className='field-help';const winner=state.players.find(player=>player.id===round.result.winner);reason.textContent=winner?`${winner.name} · +1 🥪`:'Ничья';detail.append(reason);
      const tabs=document.createElement('div');tabs.className='review-tabs';tabs.role='group';tabs.setAttribute('aria-label','Разбор предыдущего раунда');const body=document.createElement('div');
      for(const [key,label] of [['own','Ваше решение'],['opponent','Соперник'],['reference','Эталон']]){
        const tab=document.createElement('button');tab.type='button';tab.textContent=label;tab.setAttribute('aria-pressed',String(key==='own'));tab.onclick=()=>{tabs.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===tab)));body.replaceChildren();if(key==='reference'){render(body,archived.problem.reference_solution);body.className='rendered';}else{body.className='';renderHistory(archived.players.filter(player=>key==='own'?player.id===state.me:player.id!==state.me),body);body.querySelector('details')?.setAttribute('open','');}};tabs.append(tab);
      }
      const statement=document.createElement('details');statement.className='review-problem';const summary=document.createElement('summary');summary.textContent='Условие задачи';const text=document.createElement('div');text.className='rendered';render(text,archived.problem.statement);statement.append(summary,text);detail.append(statement,tabs,body);tabs.querySelector('button').click();
    }catch(error){if(selected===round.round)detail.textContent=error.message;}
  }
  for(const round of [...rounds].reverse()){const button=document.createElement('button');button.type='button';button.textContent=`Раунд ${round.round} · ${state.players.map(player=>round.scores[player.id]).join(' : ')}`;button.onclick=()=>selectRound(round,button);navigation.append(button);}
  list.replaceChildren(navigation,detail);
  let firstLoaded=false;
  $('round-history').ontoggle=()=>{if($('round-history').open && !firstLoaded){firstLoaded=true;navigation.querySelector('button')?.click();}};
  if($('round-history').open){firstLoaded=true;navigation.querySelector('button')?.click();}
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
    name.textContent = message.kind === "solution" ? `Эталон · раунд ${message.round}` : state.players.find((p) => p.id === message.player_id)?.name || "Игрок";
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
    if (draftDirty && !draftConflict && !savePromise) saveDraft();
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
  $("open-chat").onclick = () => $("chat-dialog").showModal();
  $("close-chat").onclick = () => $("chat-dialog").close();
  document.querySelectorAll('[data-review]').forEach(button=>button.addEventListener('click',()=>{reviewTab=button.dataset.review;document.querySelectorAll('[data-review]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));historySignature="";if(state)apply(state);}));
  document.querySelectorAll('[data-home-mode]').forEach(button=>button.onclick=()=>{$('create-form').hidden=button.dataset.homeMode!=='create';$('join-disclosure').hidden=button.dataset.homeMode!=='join';document.querySelectorAll('[data-home-mode]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));});
  document.querySelectorAll('[data-lobby-mode]').forEach(button=>button.onclick=()=>{
    lobbyMode=button.dataset.lobbyMode;
    apply(state);
    if(lobbyMode==='random' && (state.source!=='bank' || state.topic))action(async()=>{apply(await api(sessionPath('/topic'),'PUT',{topic:null,round:state.round}));});
    else withdrawReadyForSelection();
  });
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
  $("next-problem-json").addEventListener("input",()=>{const wasDirty=customProblemDirty;customProblemDirty=true;controls();if(!wasDirty)withdrawReadyForSelection();});
  $("next-problem-form").addEventListener("submit", (event) => {
    event.preventDefault();
    action(async () => {
      let problem;
      try { problem = JSON.parse($("next-problem-json").value); } catch { throw new Error("Проверьте формат JSON задачи."); }
      const next=await api(sessionPath("/problem"), "PUT", { problem, round: state.round });
      customProblemDirty=false;
      apply(next);
      notice("Задача обновлена. Подтвердите готовность заново.");
    });
  });
  $("next-problem-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    await withdrawReadyForSelection();
    try {
      if (file.size > 150000) throw new Error("Файл задачи должен быть меньше 150 КБ.");
      const text = await file.text();
      JSON.parse(text);
      $("next-problem-json").value = text;
      customProblemDirty=true;controls();
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
      const meta=document.createElement('div');meta.className='recent-meta';const phase=document.createElement('span');phase.textContent={lobby:'Ожидание друга',active:'Идёт раунд',grading:'Проверка решений',finished:'Раунд завершён'}[session.phase] || session.phase;const arrow=document.createElement('span');arrow.textContent='Продолжить →';meta.append(phase,arrow);link.append(name,meta);
      $("recent-list").append(link);
    }
    $("connection").textContent = "На связи";
    if (code) await poll(); else $("landing").hidden = false;
  } catch (error) { $("landing").hidden = false; notice(error.message, true); }
}

init();
