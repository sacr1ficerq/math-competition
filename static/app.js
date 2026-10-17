"use strict";

const $ = (id) => document.getElementById(id);
let config;
let customProblem = null;
let problemId = new URLSearchParams(location.search).get("problem");
let pending = false;
const submissions = [];
let solutionImages;
let restoringDraft = false;
const practiceDraftKey = () => `practice:${window.mathAccount.user?.id || "guest"}:${problemId || "custom"}`;
async function storePracticeDraft() {
  if (!config || restoringDraft) return;
  try {await window.mathDrafts.put(practiceDraftKey(), {text:$("solution").value, images:solutionImages.value});}
  catch {status("Не удалось сохранить черновик на этом устройстве. Не закрывайте страницу до отправки.",true);}
}

const render = window.renderMarkdown;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

function updateButton() {
  $("submit").disabled = !config || pending || solutionImages.busy || (!$("solution").value.trim() && !solutionImages.value.length) || !window.mathAccount.user?.has_api_key;
  solutionImages.setDisabled(pending || !config);
}

function updateScore() {
  const grades = submissions.filter((s) => s.counted && s.grade);
  const penalty = Math.max(0, grades.length - 1);
  const best = grades.length ? Math.max(...grades.map((s) => s.grade.verdict)) : 0;
  $("score").querySelector("strong").textContent = Number((best - penalty).toFixed(2));
  $("score-help").textContent = `Лучшая оценка: ${best}. Проверок: ${grades.length}. Штраф: ${penalty}.`;
}

function addSubmission(result, solution, images) {
  submissions.push({...result,solution,images});
  $('history-empty').hidden=true;
  window.mathAttempts.render($('history'),submissions.map((item,index)=>({id:`practice-${index+1}`,number:index+1,status:item.grade?'graded':'failed',verdict:item.grade?.verdict,submittedAt:new Date(item.submitted_at).getTime()/1000,result:item})),{
    key:`practice-${problemId||'custom'}`,finished:false,
    build(entry,content){
      const item=entry.result;
      if(item.error){const error=document.createElement('p');error.className='error';error.textContent=item.error;content.append(error);}
      if(item.grade){window.mathAttempts.section(content,'Разбор',item.grade.reasoning,render);if(item.grade.evidence&&item.grade.evidence!==item.grade.reasoning)window.mathAttempts.section(content,'Обоснование',item.grade.evidence,render);const heading=document.createElement('h3');heading.textContent='Отправленное решение';content.append(heading);}
      const proof=document.createElement('div');proof.className='rendered submitted-document';render(proof,item.solution||'');window.appendSolutionImages(proof,item.images||[]);content.append(proof);
    }
  });
  updateScore();
}

async function submit(event) {
  event.preventDefault();
  if ($("submit").disabled) return;
  const solution = $("solution").value;
  const images = solutionImages.value;
  pending = true;
  updateButton();
  $("submit").textContent = "Проверяется…";
  $("problem-file-bank").disabled = true;
  status("Решение проверяется. Можно продолжать работу — проверка займёт некоторое время.");
  try {
    const response = await fetch("/api/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ solution, images, ...(problemId ? {problem_id:problemId} : {problem:customProblem}) }),
    });
    const result = await response.json();
    if (!response.ok) {
      const detail = typeof result.detail === "string" ? result.detail : result.detail?.map((error) => error.msg).join("; ");
      throw new Error(detail || `Не удалось выполнить запрос (${response.status}). Попробуйте ещё раз.`);
    }
    addSubmission(result, solution, images);
    status(result.counted ? "Проверка завершена. Разбор — ниже." : result.error, !result.counted);
  } catch (error) {
    status(`${error.message} Штраф не применён.`, true);
  } finally {
    pending = false;
    $("submit").textContent = "Проверить решение";
    $("problem-file-bank").disabled = false;
    updateButton();
  }
}

async function loadProblem(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 150_000) throw new Error("Файл задачи должен быть меньше 150 КБ.");
    const problem = JSON.parse(await file.text());
    const fields = { title: 300, statement: 30000, criterions: 30000, reference_solution: 30000 };
    if (!problem || Array.isArray(problem) || typeof problem !== "object") throw new Error("Ожидается объект JSON.");
    if (Object.keys(problem).some((key) => !(key in fields))) throw new Error("В JSON задачи есть неизвестные поля.");
    for (const [key, max] of Object.entries(fields)) {
      if (typeof problem[key] !== "string" || !problem[key].trim() || problem[key].length > max) {
        throw new Error(`Заполните поле ${key} (до ${max} символов).`);
      }
    }
    customProblem = problem;
    problemId = null;
    $("problem-title").textContent = problem.title;
    render($("problem-statement"), problem.statement);
    submissions.length = 0;
    $("history").replaceChildren();
    $("history-empty").hidden = false;
    $("solution").value = "";
    solutionImages.clear();
    render($("preview"), "Здесь появится ваше решение.");
    updateScore();
    updateButton();
    $("problem-error").hidden = true;
    status("Задача загружена. Можно решать.");
  } catch (error) {
    $("problem-error").textContent = error.message;
    $("problem-error").hidden = false;
  } finally {
    event.target.value = "";
  }
}

async function init() {
  if (!window.marked || !window.DOMPurify || !window.katex) {
    status("Не удалось загрузить отображение формул. Проверьте соединение и обновите страницу.", true);
    return;
  }
  solutionImages = new window.SolutionImages($("solution-images"), $("image-attachments"), $("solution"), () => {updateButton(); storePracticeDraft();}, status);
  solutionImages.setDisabled(true);
  $("solution").addEventListener("input", () => {
    render($("preview"), $("solution").value || "Здесь появится ваше решение.");
    updateButton();
    storePracticeDraft();
  });
  $("practice-key-settings").onclick = () => window.mathAccount.open();
  window.addEventListener('accountchange', event => {$("practice-key-settings").hidden=!!event.detail?.has_api_key;$("practice-key-state").textContent = event.detail?.has_api_key ? '' : 'Для проверки решений нужен ключ.'; updateButton();});
  document.querySelectorAll('[data-workspace]').forEach(button => button.onclick = () => {document.body.dataset.workspace=button.dataset.workspace; document.querySelectorAll('[data-workspace]').forEach(item => item.setAttribute('aria-pressed',String(item === button)));});
  $("submit-form").addEventListener("submit", submit);
  $("solution").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submit(event);
  });
  await window.mathAccount.ready;
  $("practice-key-settings").hidden=!!window.mathAccount.user?.has_api_key;
  $("practice-key-state").textContent = window.mathAccount.user?.has_api_key ? '' : 'Для проверки решений нужен ключ.';
  const request = window.mathAccount.request;
  async function showCatalog() {
    const data = await request('/api/problems' + ($('bank-topic').value ? '?topic='+encodeURIComponent($('bank-topic').value) : ''));
    $('bank-list').replaceChildren();
    const groups=new Map();
    for(const problem of data.problems){if(!groups.has(problem.topic))groups.set(problem.topic,[]);groups.get(problem.topic).push(problem);}
    for(const problems of groups.values()){const heading=document.createElement('h2');heading.className='bank-group-heading';heading.textContent=problems[0].topic_label;$('bank-list').append(heading);
    for (const problem of problems) {
      const row = document.createElement('button'); row.type='button'; row.className='bank-row';
      const title=document.createElement('strong');title.textContent=problem.title;
      const meta=document.createElement('span');meta.textContent=problem.seen ? 'Открывали' : 'Новая';row.append(title,meta);
      row.onclick=()=>{if (!window.mathAccount.user) {window.mathAccount.onSignedIn=()=>{location.href="/practice?problem="+encodeURIComponent(problem.id);};window.mathAccount.open();return;} location.href='/practice?problem='+encodeURIComponent(problem.id);};$('bank-list').append(row);
    }
    }
    if (!data.problems.length) $('bank-list').textContent='В этой теме пока нет задач.';
  }
  try {
    const data = await request('/api/config'); config=data;
    const topics = await request('/api/problems/topics');
    for (const topic of topics.topics) {const option=document.createElement('option');option.value=topic.slug;option.textContent=topic.label;$('bank-topic').append(option);}
    $('bank-topic').onchange=()=>showCatalog().catch(error=>{$('bank-error').textContent=error.message;});
    $('problem-file-bank').addEventListener('change', async event=>{await loadProblem(event);if(customProblem){problemId=null;$('problem-bank').hidden=true;$('practice-work').hidden=false;}});
    if (problemId) {
      if (!window.mathAccount.user) {window.mathAccount.open(); throw new Error('Войдите, чтобы открыть задачу и сохранить историю.');}
      const problem=await request('/api/problems/'+encodeURIComponent(problemId)+'/practice','POST');
      config.problem=problem;$('problem-title').textContent=problem.title;render($('problem-statement'),problem.statement);$('problem-bank').hidden=true;$('practice-work').hidden=false;
    } else await showCatalog();
    $('model').textContent=config.model;
    if (problemId) {
      restoringDraft=true;
      try {const draft=await window.mathDrafts.get(practiceDraftKey());if(draft){$('solution').value=draft.text;solutionImages.images=draft.images || [];solutionImages.render();render($('preview'),draft.text);}} catch {status('Не удалось восстановить локальный черновик.',true);} finally {restoringDraft=false;}
    }
    updateButton();
  } catch (error) { $('bank-error').textContent=error.message; status(error.message,true); }

}

init();
