/* Finished-round reading has its own URL and context; live room state stays live. */
(() => {
 const page=document.getElementById('round-review-page');if(!page)return;
 const initial=new URLSearchParams(location.search);if(!initial.has('round'))return;
 document.body.dataset.roundReview='true';page.hidden=false;
 const archiveCache=new Map();let signature='',request=0;
 const make=(tag,className,text)=>{const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;};
 function navigate(patch){const url=new URL(location.href);for(const [key,value]of Object.entries(patch)){if(value===null)url.searchParams.delete(key);else url.searchParams.set(key,value);}history.pushState(null,'',url);signature='';draw();}
 function link(label,patch,selected){const a=make('a',selected?'is-selected':'',label);const url=new URL(location.href);for(const [k,v]of Object.entries(patch)){if(v===null)url.searchParams.delete(k);else url.searchParams.set(k,v);}a.href=url.pathname+url.search;a.setAttribute('aria-current',selected?'page':'false');a.onclick=e=>{if(e.button||e.ctrlKey||e.metaKey||e.shiftKey)return;e.preventDefault();navigate(patch);};return a;}
 function contextSignature(params){const round=Number(params.get('round'));const side=params.get('player')==='opponent'?'opponent':'own';const player=state?.players.find(p=>side==='own'?p.id===state.me:p.id!==state.me);return JSON.stringify([round,params.get('view'),side,params.get('attempt'),state?.me,round===state?.round?{phase:state.phase,problem:state.problem,name:player?.name,submissions:player?.submissions,closed:state.closed_at,key:state.has_api_key,appealsPending:state.appeals_pending}:null]);}
 async function draw(){
  if(!state)return;
  const params=new URLSearchParams(location.search),round=Number(params.get('round'));
  const key=contextSignature(params);if(key===signature)return;signature=key;const ticket=++request;
  if(!Number.isSafeInteger(round)||round<1){page.replaceChildren(make('h1','','Раунд не найден'));return;}
  let context;const current=round===state.round;
  try{
   if(current){if(state.phase!=='finished'){page.replaceChildren(make('h1','','Раунд ещё не завершён'));const back=make('a','back-link','Вернуться в комнату');back.href=`/s/${code}`;page.append(back);return;}context=state;}
   else{context=archiveCache.get(round)||await api(sessionPath(`/rounds/${round}`));archiveCache.set(round,context);}
  }catch(error){if(ticket===request){page.replaceChildren(make('h1','','Не удалось открыть разбор'),make('p','error',error.message));const back=make('a','back-link','Вернуться в комнату');back.href=`/s/${code}`;page.append(back);}return;}
  if(ticket!==request)return;
  const side=params.get('player')==='opponent'?'opponent':'own';const player=context.players.find(p=>side==='own'?p.id===state.me:p.id!==state.me);
  const submissions=player?.submissions||[];const choice=submissions.find(s=>s.id===params.get('attempt'))||submissions.filter(s=>s.status==='graded').reduce((best,s)=>!best||s.verdict>=best.verdict?s:best,null)||submissions.at(-1);
  if(choice && params.get('attempt')!==choice.id){const stableUrl=new URL(location.href);stableUrl.searchParams.set('attempt',choice.id);history.replaceState(null,'',stableUrl);signature=contextSignature(new URLSearchParams(location.search));}
  const allowed=['work','grade','appeal','reference'];const view=allowed.includes(params.get('view'))?params.get('view'):'work';
  const previousFocus=document.activeElement?.id;const selection=document.activeElement?.selectionStart!==undefined?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
  const back=make('a','back-link','Вернуться в комнату');back.href=`/s/${code}`;
  const heading=make('div','round-review-heading');heading.append(make('h1','',`Разбор раунда ${round}`),make('p','muted',context.problem?.title||'Задача дуэли'));
  const sides=make('nav','review-side-nav');sides.setAttribute('aria-label','Чья работа');sides.append(link('Ваша работа',{player:'own',attempt:null},side==='own'),link('Соперник',{player:'opponent',attempt:null},side==='opponent'));
  const toolbar=make('div','round-review-context');const stamp=make('div','round-review-stamp');stamp.append(make('strong','',choice?`Работа №${submissions.indexOf(choice)+1}`:'Работ пока нет'),make('span','subtle',player?.name||''));
  if(submissions.length>1){const select=make('select','review-attempt-picker');select.id='review-attempt';select.setAttribute('aria-label','Выбрать отправленную работу');for(const [i,s]of submissions.entries()){const option=new Option(`Работа №${i+1} · ${s.status==='failed'?'Ошибка проверки':s.status==='pending'?'Проверяется':`${s.verdict} / 10`}`,s.id);option.selected=s===choice;select.append(option);}select.onchange=()=>navigate({attempt:select.value});stamp.append(select);}
  const score=make('div','round-review-score');if(choice){score.classList.toggle('is-status',typeof choice.verdict!=='number');score.append(make('strong','',typeof choice.verdict==='number'?String(choice.verdict):choice.status==='failed'?'Ошибка проверки':'Проверяется'));if(typeof choice.verdict==='number')score.append(make('span','','/ 10'));if(choice.appeal?.status==='graded')score.append(make('small','',`После апелляции · ${choice.appeal.old_verdict} → ${choice.appeal.effective_verdict}`));}
  toolbar.append(stamp,score);
  const sections=make('nav','review-section-nav');sections.setAttribute('aria-label','Раздел разбора');for(const [id,label]of [['work','Работа'],['grade','Оценка'],['appeal','Апелляция'],['reference','Эталон']])sections.append(link(label,{view:id},view===id));
  const content=make('article','round-review-document');content.tabIndex=-1;
  if(view==='reference'){
   const problem=make('details','review-problem');problem.append(make('summary','','Условие и критерии'));const statement=make('div','rendered');render(statement,context.problem?.statement||'');const criteria=make('div','rendered');render(criteria,context.problem?.criterions||'');problem.append(statement,make('h3','','Критерии оценивания'),criteria);content.append(problem,make('h2','','Полное решение'));const body=make('div','rendered');render(body,context.problem?.reference_solution||'Автор не добавил полное решение.');content.append(body);
  }else if(!choice)content.append(make('p','muted','Решение не отправлено.'));
  else if(view==='work'){
   const problem=make('details','review-problem');problem.append(make('summary','','Условие задачи'));const statement=make('div','rendered');render(statement,context.problem?.statement||'');problem.append(statement);content.append(problem,make('h2','',`Отправленная работа №${submissions.indexOf(choice)+1}`));const proof=make('div','rendered submitted-document');render(proof,choice.solution||'');window.appendSolutionImages(proof,choice.images||[]);content.append(proof);
  }else if(view==='grade'){
   const effective=choice.appeal?.status==='graded'?(choice.appeal.grade||choice.grade):choice.grade;
   content.append(make('h2','','Оценка работы'));
   if(choice.error)content.append(make('p','error',choice.error));
   if(!effective&&!choice.error)content.append(make('p','muted','Проверка ещё не завершена.'));
   if(effective){const reasoning=make('div','rendered');render(reasoning,effective.reasoning||'');content.append(reasoning);if(effective.evidence&&effective.evidence!==effective.reasoning){content.append(make('h3','','Обоснование'));const evidence=make('div','rendered');render(evidence,effective.evidence);content.append(evidence);}}
   if(choice.appeal?.status==='graded'){const history=make('details','original-grade-history');history.append(make('summary','',`Исходная оценка: ${choice.appeal.old_verdict} из 10`));const original=make('div','rendered');render(original,choice.grade?.reasoning||'');history.append(original);content.append(history);}
  }else{
   const appeal=buildAppealRegion(choice,player,current);if(appeal){appeal.region.hidden=false;appeal.region.classList.add('dedicated-appeal');const contextNote=appeal.region.querySelector('.appeal-context');if(contextNote)contextNote.textContent=`Работа отправлена ${timeText(choice.submitted_at)}. Исходный текст доступен в разделе «Работа».`;content.append(appeal.region);}else content.append(make('h2','','Апелляция'),make('p','muted',current?'Апелляция для этой работы недоступна.':'Раунд завершён. Апелляции доступны только до начала следующего раунда.'));
  }
  const archived=make('p','review-archive-note',current?'':'Архив раунда · только просмотр');archived.hidden=current;
  page.replaceChildren(back,heading,sides,toolbar,sections,archived,content);
  const attemptPicker=page.querySelector('.review-attempt-picker');if(attemptPicker)window.mathUI.enhanceSelect(attemptPicker);
  if(previousFocus){const replacement=document.getElementById(previousFocus);replacement?.focus({preventScroll:true});if(selection&&replacement?.setSelectionRange)replacement.setSelectionRange(...selection);}
 }
 window.addEventListener('math:state',draw);window.addEventListener('popstate',()=>{signature='';draw();});if(state)draw();
})();
