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
      if (typeof problem[key] !== "string" || (key !== "reference_solution" && !problem[key].trim()) || problem[key].length > max) {
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
  let catalogProblems=[],catalogTopics=[],catalogPage=0;
  function drawCatalog(){
    const topic=$('bank-topic').value,query=$('bank-search').value.trim().toLocaleLowerCase('ru');
    const filtered=catalogProblems.filter(problem=>(!topic||problem.topic===topic)&&(!query||problem.title.toLocaleLowerCase('ru').includes(query)));
    $('bank-list').replaceChildren();$('bank-collection-title').textContent=catalogTopics.find(item=>item.slug===topic)?.label||'Все задачи';$('bank-count').textContent=`Задач: ${filtered.length}`;
    document.querySelectorAll('[data-bank-topic]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.bankTopic===topic)));
    const groups=new Map();for(const problem of filtered){if(!groups.has(problem.topic))groups.set(problem.topic,[]);groups.get(problem.topic).push(problem);}
    for(const problems of groups.values()){
      const group=document.createElement('section');group.className='library-group';
      if(!topic){const heading=document.createElement('h3');heading.className='bank-group-heading';heading.textContent=problems[0].topic_label;group.append(heading);}
      const grid=document.createElement('div');grid.className='library-grid';
      const visible=topic?problems.slice(catalogPage*12,(catalogPage+1)*12):problems.slice(0,matchMedia('(max-width:720px)').matches?2:4);
      for(const problem of visible){
        const row=document.createElement('button');row.type='button';row.className='bank-row';
        const title=document.createElement('strong');title.textContent=problem.title;row.append(title);
        if(problem.seen){const seen=document.createElement('span');seen.className='bank-seen';seen.textContent='Открывали';row.append(seen);}
        row.onclick=()=>{if(!window.mathAccount.user){window.mathAccount.onSignedIn=()=>{location.href='/practice?problem='+encodeURIComponent(problem.id);};window.mathAccount.open();return;}location.href='/practice?problem='+encodeURIComponent(problem.id);};grid.append(row);
      }group.append(grid);
      if(!topic&&problems.length>(matchMedia('(max-width:720px)').matches?2:4)){const more=document.createElement('button');more.type='button';more.className='library-more quiet';more.textContent=`Все задачи: ${problems.length}`;more.onclick=()=>{$('bank-topic').value=problems[0].topic;catalogPage=0;drawCatalog();};group.querySelector('.bank-group-heading').append(more);}
      if(topic&&problems.length>12){const paging=document.createElement('div');paging.className='library-pagination';const prev=document.createElement('button');prev.type='button';prev.textContent='Назад';prev.disabled=catalogPage===0;prev.onclick=()=>{catalogPage--;drawCatalog();};const count=document.createElement('span');count.textContent=`${catalogPage+1} из ${Math.ceil(problems.length/12)}`;const next=document.createElement('button');next.type='button';next.textContent='Далее';next.disabled=(catalogPage+1)*12>=problems.length;next.onclick=()=>{catalogPage++;drawCatalog();};paging.append(prev,count,next);group.append(paging);}
      $('bank-list').append(group);
    }
    if(!filtered.length){const empty=document.createElement('div');empty.className='library-empty';const title=document.createElement('h3');title.textContent=query?'Ничего не найдено':'В этой теме пока нет задач';const help=document.createElement('p');help.textContent=query?'Попробуйте другое название или выберите все темы.':'Выберите другую тему.';empty.append(title,help);$('bank-list').append(empty);}
  }
  async function showCatalog(){const data=await request('/api/problems');catalogProblems=data.problems;drawCatalog();}
  function drawTopics(){
    $('bank-topics').replaceChildren();
    for(const topic of [{slug:'',label:'Все задачи'},...catalogTopics]){const button=document.createElement('button');button.type='button';button.dataset.bankTopic=topic.slug;const label=document.createElement('span');label.textContent=topic.label;const count=document.createElement('span');count.className='topic-count';count.textContent=catalogProblems.filter(problem=>!topic.slug||problem.topic===topic.slug).length;button.append(label,count);button.onclick=()=>{$('bank-topic').value=topic.slug;catalogPage=0;drawCatalog();};$('bank-topics').append(button);}
  }

  try {
    const data = await request('/api/config'); config=data;
    const topics = await request('/api/problems/topics');
    for (const topic of topics.topics) {const option=document.createElement('option');option.value=topic.slug;option.textContent=topic.label;$('bank-topic').append(option);}
    catalogTopics=topics.topics;
    matchMedia('(max-width:720px)').addEventListener('change',()=>{if(!$('problem-bank').hidden)drawCatalog();});
    $('bank-topic').onchange=()=>{catalogPage=0;drawCatalog();};$('bank-search').addEventListener('input',()=>{catalogPage=0;drawCatalog();});
    const customForm=window.mathProblemForm($('practice-problem-fields'),{prefix:'practice-custom',fileId:'problem-file-bank'});
    $('open-custom-problem').onclick=()=>$('custom-problem-dialog').showModal();$('close-custom-problem').onclick=()=>$('custom-problem-dialog').close();
    $('practice-custom-form').onsubmit=async event=>{event.preventDefault();$('practice-custom-error').textContent='';try{const problem=customForm.get();await loadProblem({target:{files:[new File([JSON.stringify(problem)],'task.json',{type:'application/json'})],value:''}});if(customProblem){$('problem-bank').hidden=true;$('practice-work').hidden=false;$('custom-problem-dialog').close();}}catch(error){$('practice-custom-error').textContent=error.message;}};

    if (problemId) {
      if (!window.mathAccount.user) {window.mathAccount.open(); throw new Error('Войдите, чтобы открыть задачу и сохранить историю.');}
      const problem=await request('/api/problems/'+encodeURIComponent(problemId)+'/practice','POST');
      config.problem=problem;$('problem-title').textContent=problem.title;render($('problem-statement'),problem.statement);$('problem-bank').hidden=true;$('practice-work').hidden=false;
    } else {await showCatalog();drawTopics();drawCatalog();}
    $('model').textContent=config.model;
    if (problemId) {
      restoringDraft=true;
      try {const draft=await window.mathDrafts.get(practiceDraftKey());if(draft){$('solution').value=draft.text;solutionImages.images=draft.images || [];solutionImages.render();render($('preview'),draft.text);}} catch {status('Не удалось восстановить локальный черновик.',true);} finally {restoringDraft=false;}
    }
    updateButton();
  } catch (error) { $('bank-error').textContent=error.message; status(error.message,true); }

}

init();
