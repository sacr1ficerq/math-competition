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
