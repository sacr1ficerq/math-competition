/* Small shared controls, with native inputs retained as the data contract. */
(() => {
  const pickers=[];
  function enhance(select) {
    if(select.dataset.enhanced) return;
    select.dataset.enhanced='true';
    const wrapper=document.createElement('div');wrapper.className='select-picker';
    const trigger=document.createElement('button');trigger.type='button';trigger.id=select.id+'-control';trigger.className='select-trigger';trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');
    const text=document.createElement('span');const arrow=document.createElementNS('http://www.w3.org/2000/svg','svg');arrow.setAttribute('viewBox','0 0 20 20');arrow.setAttribute('aria-hidden','true');arrow.innerHTML='<path d="m6 8 4 4 4-4"/>';trigger.append(text,arrow);
    const menu=document.createElement('div');menu.className='select-menu';menu.id=select.id+'-options';menu.role='listbox';menu.hidden=true;trigger.setAttribute('aria-controls',menu.id);
    select.after(wrapper);wrapper.append(trigger,menu);select.hidden=true;
    document.querySelectorAll('label').forEach(label=>{if(label.htmlFor===select.id){label.htmlFor=trigger.id;trigger.setAttribute('aria-labelledby',label.id ||= select.id+'-label');menu.setAttribute('aria-labelledby',label.id);}});
    function close(focus=false){menu.hidden=true;trigger.setAttribute('aria-expanded','false');if(focus)trigger.focus();}
    function sync(){text.textContent=select.selectedOptions[0]?.textContent || 'Выберите тему';trigger.disabled=select.disabled;for(const option of menu.children)option.setAttribute('aria-selected',String(option.dataset.value===select.value));}
    function build(){const focused=menu.contains(document.activeElement);menu.replaceChildren();for(const option of select.options){const item=document.createElement('button');item.type='button';item.role='option';item.className='select-option';item.dataset.value=option.value;item.textContent=option.textContent;item.disabled=option.disabled;item.tabIndex=-1;item.onclick=()=>{select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));sync();close(true);};menu.append(item);}sync();if(focused)menu.querySelector('[aria-selected="true"]')?.focus();}
    function open(last=false){build();menu.hidden=false;trigger.setAttribute('aria-expanded','true');const options=[...menu.children].filter(item=>!item.disabled);(last?options.at(-1):menu.querySelector('[aria-selected="true"]') || options[0])?.focus();}
    trigger.onclick=()=>menu.hidden?open():close();
    wrapper.addEventListener('keydown',event=>{const options=[...menu.children].filter(item=>!item.disabled);let index=options.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();close(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();if(menu.hidden){open(event.key==='ArrowUp');return;}index=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;options[index]?.focus();}else if(event.key==='Tab')close();});
    document.addEventListener('pointerdown',event=>{if(!wrapper.contains(event.target))close();});select.addEventListener('change',sync);new MutationObserver(build).observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','selected']});pickers.push(sync);build();
  }
  window.mathUI={syncPickers(){pickers.forEach(sync=>sync());}};
  document.querySelectorAll('select[data-picker]').forEach(enhance);
})();

/* Shared attempt presentation for duel review and practice. */
(() => {
  function summary({number, status, verdict, submittedAt, best = false}) {
    const node = document.createElement('summary');
    node.className = 'attempt-heading';
    const identity = document.createElement('div');
    identity.className = 'attempt-identity';
    const title = document.createElement('span');
    title.className = 'attempt-title';
    title.textContent = `Попытка ${number}`;
    const bestLabel = document.createElement('span');
    bestLabel.className = 'attempt-best';
    bestLabel.textContent = 'Лучшая оценка';
    bestLabel.hidden = !best;
    const labelRow = document.createElement('div');
    labelRow.className = 'attempt-label-row';
    labelRow.append(title, bestLabel);
    const meta = document.createElement('div');
    meta.className = 'attempt-meta';
    const state = document.createElement('span');
    state.className = 'attempt-state';
    state.textContent = status === 'pending' ? 'Проверяется' : status === 'failed' ? 'Ошибка проверки · без штрафа' : 'Проверено';
    const time = document.createElement('time');
    time.dateTime = new Date(submittedAt * 1000).toISOString();
    time.textContent = new Date(submittedAt * 1000).toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit', hour12:false});
    time.title = new Date(submittedAt * 1000).toLocaleString('ru-RU');
    meta.append(state, time);
    identity.append(labelRow, meta);
    const score = document.createElement('div');
    score.className = 'attempt-score';
    if (status === 'graded' && typeof verdict === 'number') {
      const value = document.createElement('strong');
      value.textContent = verdict;
      const scale = document.createElement('span');
      scale.textContent = '/ 10';
      score.append(value, scale);
      score.setAttribute('aria-label', `Оценка: ${verdict} из 10`);
    } else {
      const mark = document.createElement('span');
      mark.className = 'attempt-score-placeholder';
      mark.textContent = status === 'pending' ? '…' : '—';
      mark.setAttribute('aria-label', status === 'pending' ? 'Ожидаем оценку' : 'Оценка не получена');
      score.append(mark);
    }
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('viewBox', '0 0 20 20');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.classList.add('attempt-chevron');
    chevron.innerHTML = '<path d="m6 8 4 4 4-4"/>';
    node.append(identity, score, chevron);
    return node;
  }
  function section(target, title, text, render, {folded = false, id = '', open = false} = {}) {
    const wrapper = document.createElement(folded ? 'details' : 'section');
    wrapper.className = folded ? 'review-disclosure' : 'review-block';
    if (id) wrapper.id = id;
    const heading = document.createElement(folded ? 'summary' : 'h3');
    heading.textContent = title;
    if (folded) wrapper.open = open;
    const body = document.createElement('div');
    body.className = 'rendered';
    render(body, text);
    wrapper.append(heading, body);
    target.append(wrapper);
    return body;
  }
  window.mathAttempts = {summary, section};
})();

/* One review document, navigated by a compact attempt timeline. */
(() => {
  const views = new Map();
  window.mathAttempts.render = function(target, entries, {key, finished, build}) {
    const focusedId=target.contains(document.activeElement)?document.activeElement.id:null;
    const selection=target.contains(document.activeElement)&&document.activeElement.selectionStart!==undefined?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
    const best=entries.filter(entry=>entry.status==='graded'&&typeof entry.verdict==='number').reduce((a,b)=>!a||b.verdict>=a.verdict?b:a,null);
    const latest=entries.at(-1);
    const view=views.get(key)||{choice:null,latest:null,userChosen:false,finished:false};
    if(!entries.some(entry=>entry.id===view.choice)||(!view.userChosen&&finished&&!view.finished))view.choice=(finished&&best?best:latest)?.id;
    else if(!view.userChosen&&latest?.id!==view.latest&&view.choice===view.latest)view.choice=latest?.id;
    view.latest=latest?.id;view.finished=finished;views.set(key,view);
    const rail=document.createElement('div');rail.className='attempt-rail';rail.role='tablist';rail.setAttribute('aria-label','Попытки решения');
    const pane=document.createElement('section');pane.className='review-stage';pane.role='tabpanel';pane.tabIndex=0;
    const prefix=key.replace(/[^a-zA-Z0-9_-]/g,'-');pane.id=prefix+'-review';
    function show(entry,manual=false){
      view.choice=entry.id;if(manual)view.userChosen=true;
      rail.querySelectorAll('button').forEach(button=>{const selected=button.dataset.id===entry.id;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
      pane.setAttribute('aria-labelledby',prefix+'-'+entry.id);pane.replaceChildren();
      const heading=document.createElement('div');heading.className='review-document-toolbar';
      const stamp=document.createElement('div');stamp.className='review-document-stamp';const time=document.createElement('time');time.dateTime=new Date(entry.submittedAt*1000).toISOString();time.title=new Date(entry.submittedAt*1000).toLocaleString('ru-RU');time.textContent='Отправлено '+new Date(entry.submittedAt*1000).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',hour12:false});stamp.append(time);
      if(entries.length>1&&best?.id===entry.id){const label=document.createElement('span');label.className='attempt-best';label.textContent='Лучшая оценка';stamp.append(label);}
      const verdict=document.createElement('div');verdict.className='review-document-verdict';
      const number=document.createElement('strong');number.textContent=typeof entry.verdict==='number'?entry.verdict:entry.status==='pending'?'Проверяется':'Ошибка проверки';
      if(typeof entry.verdict==='number'){const scale=document.createElement('span');scale.textContent='/ 10';verdict.append(number,scale);}else{verdict.classList.add('is-status');verdict.append(number);}
      heading.append(stamp,verdict);
      const content=document.createElement('div');content.className='review-document-content';pane.append(heading,content);
      build(entry,content,heading);
    }
    for(const entry of entries){const button=document.createElement('button');button.type='button';button.role='tab';button.id=prefix+'-'+entry.id;button.dataset.id=entry.id;button.setAttribute('aria-controls',pane.id);const number=document.createElement('span');number.className='attempt-rail-number';number.textContent="№ " + entry.number;const verdict=document.createElement('span');verdict.className='attempt-rail-verdict';verdict.textContent=typeof entry.verdict==='number'?`${entry.verdict} / 10`:entry.status==='pending'?'Проверяется':'Ошибка';button.dataset.status=entry.status;button.setAttribute('aria-label',`Попытка ${entry.number}: ${verdict.textContent}${entry.id===best?.id?', лучшая оценка':''}`);button.append(number,verdict);button.onclick=()=>show(entry,true);rail.append(button);}
    rail.onkeydown=event=>{const buttons=[...rail.children],index=buttons.indexOf(document.activeElement);if(index<0)return;let next;if(event.key==='ArrowRight')next=(index+1)%buttons.length;else if(event.key==='ArrowLeft')next=(index-1+buttons.length)%buttons.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=buttons.length-1;else return;event.preventDefault();buttons[next].click();buttons[next].focus({preventScroll:true});rail.scrollLeft=Math.max(0,buttons[next].offsetLeft-rail.offsetLeft-rail.clientWidth/2+buttons[next].offsetWidth/2);};
    target.replaceChildren(rail,pane);
    if(entries.length){show(entries.find(entry=>entry.id===view.choice)||latest);const active=rail.querySelector('[aria-selected=\"true\"]');if(active)rail.scrollLeft=Math.max(0,active.offsetLeft-rail.offsetLeft-rail.clientWidth/2+active.offsetWidth/2);}
    if(focusedId){const replacement=document.getElementById(focusedId);replacement?.focus({preventScroll:true});if(selection&&replacement?.setSelectionRange)replacement.setSelectionRange(...selection);}
  };
})();

/* Only the artwork responds to a fine pointer; controls keep stable hit areas. */
(() => {
  document.addEventListener('keydown',()=>document.documentElement.classList.add('keyboard-input'));
  document.addEventListener('pointerdown',()=>document.documentElement.classList.remove('keyboard-input'));
  const region=document.getElementById('landing'),art=region?.querySelector('.math-arena');
  if(!art)return;
  const pointer=matchMedia('(hover: hover) and (pointer: fine)'),motion=matchMedia('(prefers-reduced-motion: reduce)');
  let frame=0,currentX=0,currentY=0,targetX=0,targetY=0;
  function tick(){
    currentX+=(targetX-currentX)*.16;currentY+=(targetY-currentY)*.16;
    if(Math.abs(currentX-targetX)<.03&&Math.abs(currentY-targetY)<.03){currentX=targetX;currentY=targetY;frame=0;}else frame=requestAnimationFrame(tick);
    art.style.transform=currentX||currentY?`perspective(900px) translate3d(${currentX}px,${currentY}px,0) rotateX(${-currentY*.22}deg) rotateY(${currentX*.22}deg)`:'';
  }
  function start(){if(!frame)frame=requestAnimationFrame(tick);}
  function reset(){targetX=targetY=0;start();}
  function preference(){if(motion.matches||!pointer.matches){cancelAnimationFrame(frame);frame=0;currentX=currentY=targetX=targetY=0;art.style.transform='';}}
  region.addEventListener('pointermove',event=>{if(motion.matches||!pointer.matches||event.pointerType==='touch')return;const box=region.getBoundingClientRect();targetX=Math.max(-8,Math.min(8,(event.clientX-box.left-box.width/2)*.016));targetY=Math.max(-6,Math.min(6,(event.clientY-box.top-box.height/2)*.016));start();});
  region.addEventListener('pointerleave',reset);motion.addEventListener('change',preference);pointer.addEventListener('change',preference);
})();
