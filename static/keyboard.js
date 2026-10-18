/* Commands share the same actions as the visible UI; typing keeps its ordinary keys. */
(() => {
  const typing=target=>!!target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
  const shown=el=>!!el&&!el.disabled&&!el.closest('[hidden]')&&el.getClientRects().length>0;
  const find=id=>document.getElementById(id);
  let letterCommands=true;try{letterCommands=localStorage.getItem('math-letter-commands')!=='off';}catch{}
  const commands=()=>[
    {id:'home',label:'Главная',keys:'G H',run:()=>location.assign('/')},
    {id:'bank',label:'Библиотека задач',keys:'G B',run:()=>location.assign('/practice')},
    {id:'chat',label:find('open-chat')?.getAttribute('aria-expanded')==='true'?'Закрыть чат':'Открыть чат',keys:'C',available:()=>shown(find('open-chat')),run:()=>find('open-chat').click()},
    {id:'write',label:'Перейти к решению',keys:'I',available:()=>shown(find('solution')),run:()=>find('solution').focus()},
    {id:'review',label:'Разбор раунда',available:()=>shown(find('round-review-link')),run:()=>find('round-review-link').click()},
    {id:'appeal',label:'Апелляция',available:()=>shown(find('result-appeal-link')),run:()=>find('result-appeal-link').click()},
    {id:'settings',label:'Настройки аккаунта',available:()=>shown(find('open-settings')),run:()=>find('open-settings').click()},
    {id:'theme',label:'Оформление',available:()=>shown(find('open-appearance')),run:()=>find('open-appearance').click()}
  ].filter(command=>!command.available||command.available());
  const dialog=document.createElement('dialog');dialog.className='command-dialog';dialog.id='command-dialog';dialog.setAttribute('aria-labelledby','command-title');
  const title=document.createElement('h2');title.id='command-title';title.textContent='Действия и клавиши';
  const header=document.createElement('div');header.className='command-header';
  const close=document.createElement('button');close.type='button';close.className='quiet command-close';close.setAttribute('aria-label','Закрыть меню действий');close.textContent='×';close.onclick=()=>dialog.close();header.append(title,close);
  const input=document.createElement('input');input.type='search';input.id='command-search';input.placeholder='Найти действие…';input.setAttribute('aria-label','Найти действие');input.autocomplete='off';input.spellcheck=false;
  const list=document.createElement('div');list.className='command-list';list.id='command-list';list.setAttribute('role','listbox');list.setAttribute('aria-label','Действия');
  input.setAttribute('role','combobox');input.setAttribute('aria-controls',list.id);input.setAttribute('aria-expanded','false');input.setAttribute('aria-autocomplete','list');
  const help=document.createElement('p');help.className='command-help';help.textContent='↑ ↓ — выбрать · Enter — выполнить · Esc — закрыть';
  const keys=document.createElement('p');keys.className='command-key-help';keys.textContent='Ctrl/⌘ K — действия · ? — подсказка · Ctrl/⌘ Enter — проверить решение. В каталоге: J/K — выбрать, Enter — открыть. Буквенные команды работают вне полей ввода.';
  const preference=document.createElement('label');preference.className='command-preference';const enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=letterCommands;enabled.onchange=()=>{letterCommands=enabled.checked;try{localStorage.setItem('math-letter-commands',letterCommands?'on':'off');}catch{}};preference.append(enabled,document.createTextNode('Буквенные команды вне полей ввода'));
  dialog.append(header,input,list,help,keys,preference);document.body.append(dialog);
  let selected=0,visible=[],returnFocus=null,prefix='',prefixTimer;
  function select(index){selected=Math.max(0,Math.min(index,visible.length-1));[...list.querySelectorAll('[role="option"]')].forEach((option,i)=>{option.setAttribute('aria-selected',String(i===selected));});if(visible.length)input.setAttribute('aria-activedescendant','command-option-'+selected);else input.removeAttribute('aria-activedescendant');}
  function execute(command){dialog.close();command.run();}
  function render(){visible=commands().filter(command=>command.label.toLocaleLowerCase('ru').includes(input.value.trim().toLocaleLowerCase('ru')));list.replaceChildren();visible.forEach((command,index)=>{const button=document.createElement('button');button.type='button';button.role='option';button.id='command-option-'+index;button.tabIndex=-1;button.className='command-item';const label=document.createElement('span');label.textContent=command.label;button.append(label);if(command.keys){const key=document.createElement('kbd');key.textContent=command.keys;button.append(key);}button.onclick=()=>execute(command);button.onpointermove=()=>select(index);list.append(button);});if(!visible.length){const empty=document.createElement('p');empty.className='command-empty';empty.textContent='Действие не найдено.';list.append(empty);}select(0);}
  function open(){if(document.querySelector('dialog[open]'))return;returnFocus=document.activeElement;input.value='';render();dialog.showModal();input.setAttribute('aria-expanded','true');input.focus();}
  dialog.addEventListener('close',()=>{input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();}});
  input.addEventListener('input',render);
  dialog.addEventListener('keydown',event=>{if(event.key==='Escape')event.stopPropagation();if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();select((selected+(event.key==='ArrowDown'?1:-1)+visible.length)%Math.max(1,visible.length));list.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});}else if(event.key==='Enter'){event.preventDefault();if(visible[selected])execute(visible[selected]);}});
  const trigger=document.createElement('button');trigger.type='button';trigger.className='quiet keyboard-trigger';trigger.textContent='Клавиши';trigger.setAttribute('aria-label','Действия и горячие клавиши');trigger.setAttribute('aria-keyshortcuts','Control+k Meta+k');trigger.onclick=open;
  const chrome=document.querySelector('.account-actions,.header-actions,.nav-actions,.account');(chrome||document.querySelector('header'))?.append(trigger);
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing||event.repeat)return;
    if((event.ctrlKey||event.metaKey)&&event.code==='KeyK'&&!event.altKey){event.preventDefault();if(dialog.open)dialog.close();else open();return;}
    if(document.querySelector('dialog[open]')||typing(event.target)||event.ctrlKey||event.metaKey||event.altKey)return;
    if(!letterCommands)return;
    if(event.key==='?'){event.preventDefault();open();return;}
    const letter=event.code.startsWith('Key')?event.code.slice(3).toLowerCase():event.key.toLowerCase();
    if(prefix==='g'){prefix='';clearTimeout(prefixTimer);const action=letter==='h'?'home':letter==='b'?'bank':null;if(action){event.preventDefault();commands().find(command=>command.id===action)?.run();return;}}
    if(letter==='g'&&!event.shiftKey){prefix='g';clearTimeout(prefixTimer);prefixTimer=setTimeout(()=>prefix='',900);return;}
    const command=letter==='c'?'chat':letter==='i'?'write':null;
    if(command){const action=commands().find(item=>item.id===command);if(action){event.preventDefault();action.run();}return;}
    if(letter==='j'||letter==='k'){const rows=[...document.querySelectorAll('.bank-row')].filter(shown);if(!rows.length)return;event.preventDefault();const index=rows.indexOf(document.activeElement);rows[index<0?(letter==='j'?0:rows.length-1):(index+(letter==='j'?1:-1)+rows.length)%rows.length].focus();}
  });
})();
