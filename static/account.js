/* Authentication, account preferences, and appearance are distinct dialogs. */
(() => {
  let user = null;
  const $ = id => document.getElementById(id);
  async function request(path, method = 'GET', body) {
    const response = await fetch(path, {method, credentials:'same-origin', cache:'no-store', headers:body ? {'Content-Type':'application/json'} : {}, body:body ? JSON.stringify(body) : undefined});
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : data.detail?.map(item => item.msg).join('; ') || 'Не удалось выполнить запрос.');
    return data;
  }
  $('account-shell').innerHTML = `
    <dialog id="account-dialog" aria-labelledby="account-title">
      <form id="account-form">
        <div class="dialog-heading"><h2 id="account-title">Вход</h2><button type="button" id="close-account" aria-label="Закрыть вход">×</button></div>
        <p id="account-description" class="muted">История задач сохраняется в вашем аккаунте.</p>
        <label for="account-login">Логин</label><input id="account-login" autocomplete="username" required maxlength="64">
        <div id="register-fields" hidden><label for="account-name">Как вас называть</label><input id="account-name" autocomplete="nickname" maxlength="40"></div>
        <label for="account-password">Пароль</label><input id="account-password" type="password" autocomplete="current-password" required>
        <small id="password-help" hidden>От 8 символов. Логин: латинские буквы, цифры, _, . и -.</small>
        <p id="account-error" class="error" role="alert"></p>
        <button id="account-submit" type="submit" class="primary">Войти</button>
        <button id="switch-auth" type="button" class="quiet">Создать аккаунт</button>
      </form>
    </dialog>
    <dialog id="settings-dialog" aria-labelledby="settings-title">
      <div class="dialog-heading"><h2 id="settings-title">Настройки аккаунта</h2><button id="close-settings" type="button" aria-label="Закрыть настройки">×</button></div>
      <p id="signed-name" class="account-status"></p>
      <section class="settings-section"><h3>Проверка решений</h3>
        <div class="key-connected"><p id="account-key-state"></p><button id="change-account-key" type="button" class="quiet">Подключить</button></div>
        <form id="account-key-form" hidden><label for="account-key">Ключ OpenRouter</label><input id="account-key" type="password" placeholder="sk-or-…" autocomplete="off" maxlength="512"><small>Сохраняется зашифрованным для следующих игр.</small><p id="key-save-status" class="error" role="alert"></p><div class="dialog-actions"><button type="submit">Сохранить</button><button type="button" id="account-delete-key" class="quiet">Удалить ключ</button></div></form>
      </section>
      <section class="settings-section"><h3>Модель по умолчанию</h3>
        <form id="default-model-form"><div class="model-picker"><label class="sr-only" for="default-model-search">Найти модель</label><input id="default-model-search" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="model-options" autocomplete="off" placeholder="Название или provider/model"><div id="model-options" class="model-options" role="listbox" aria-label="Модели OpenRouter" hidden></div></div><p class="field-help">Для новых дуэлей и тренировки. Текущая игра не изменится.</p><p id="model-save-status" class="field-help" role="status"></p><button id="save-default-model" type="submit">Сохранить модель</button></form>
      </section>
      <p id="settings-error" class="error" role="alert"></p>
      <div class="settings-footer"><button id="logout" type="button" class="quiet">Выйти из аккаунта</button></div>
    </dialog>
    <dialog id="appearance-dialog" class="appearance-dialog" aria-labelledby="appearance-title">
      <div class="dialog-heading"><h2 id="appearance-title">Оформление</h2><button id="close-appearance" type="button" aria-label="Закрыть оформление">×</button></div>
      <div class="theme-options" role="group" aria-label="Цветовая тема"><button type="button" data-theme-choice="system">Системное</button><button type="button" data-theme-choice="light">Светлое</button><button type="button" data-theme-choice="dark">Тёмное</button></div>
    </dialog>`;

  let register = false;
  let models = [], modelsPromise = null, savedDefault = null, catalogStale = false, suppressModelFocus = false, modelOpenIntent = false;
  const modelInput = $('default-model-search'), options = $('model-options');
  const fallbackMessage = 'Список временно недоступен. Можно указать provider/model вручную.';
  function update(next) {
    user = next;
    $('open-settings').textContent = user ? user.display_name : 'Войти';
    $('open-settings').setAttribute('aria-label', user ? 'Настройки аккаунта '+user.display_name : 'Войти в аккаунт');
    if (!user) return;
    $('signed-name').textContent = `${user.display_name} · @${user.login}`;
    $('account-key-state').textContent = user.has_api_key ? 'OpenRouter подключён' : 'Ключ не подключён';
    $('change-account-key').textContent = user.has_api_key ? 'Изменить' : 'Подключить';
    $('account-delete-key').hidden = !user.has_api_key;
    if (document.activeElement !== modelInput) modelInput.value = user.default_model || savedDefault || '';
    window.dispatchEvent(new CustomEvent('accountchange', {detail:user}));
  }
  function openAccount() {
    if (user) { $('settings-dialog').showModal(); loadModels(); }
    else $('account-dialog').showModal();
  }
  async function run(button, callback, errorTarget = $('settings-error')) {
    button.disabled = true; errorTarget.textContent = ''; errorTarget.classList.remove('error');
    try { await callback(); } catch (error) { errorTarget.textContent = error.message; errorTarget.classList.add('error'); }
    finally { button.disabled = false; }
  }
  $('open-settings').onclick = openAccount;
  $('close-account').onclick = () => {window.mathAccount.onSignedIn=null;$('account-dialog').close();};
  $('account-dialog').addEventListener('cancel', () => {window.mathAccount.onSignedIn=null;});
  $('close-settings').onclick = () => $('settings-dialog').close();
  $('open-appearance').onclick = () => $('appearance-dialog').showModal();
  $('close-appearance').onclick = () => $('appearance-dialog').close();
  function syncThemeChoices() {document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === window.mathTheme.value)));}
  document.querySelectorAll('[data-theme-choice]').forEach(button => button.onclick = () => {window.mathTheme.set(button.dataset.themeChoice);syncThemeChoices();});
  window.addEventListener('storage', syncThemeChoices);
  syncThemeChoices();
  $('switch-auth').onclick = () => {
    register = !register;
    $('register-fields').hidden = !register; $('password-help').hidden = !register;
    $('account-name').required = register; $('account-password').minLength = register ? 8 : 1;
    $('account-password').autocomplete = register ? 'new-password' : 'current-password';
    $('account-title').textContent = register ? 'Создать аккаунт' : 'Вход';
    $('account-submit').textContent = register ? 'Создать аккаунт' : 'Войти';
    $('switch-auth').textContent = register ? 'Уже есть аккаунт' : 'Создать аккаунт';
    $('account-error').textContent = '';
  };
  $('account-form').onsubmit = event => {
    event.preventDefault();
    run($('account-submit'), async () => {
      const result = await request(`/api/auth/${register ? 'register' : 'login'}`, 'POST', {login:$('account-login').value, password:$('account-password').value, ...(register ? {display_name:$('account-name').value} : {})});
      $('account-password').value = ''; update(result.user); $('account-dialog').close();
      window.dispatchEvent(new Event('accountauthenticated'));
      if (window.mathAccount.onSignedIn) {const callback=window.mathAccount.onSignedIn;window.mathAccount.onSignedIn=null;callback();}
    }, $('account-error'));
  };
  $('change-account-key').onclick = () => {$('account-key-form').hidden=!$('account-key-form').hidden;if (!$('account-key-form').hidden) $('account-key').focus();};
  $('account-key-form').onsubmit = event => {
    event.preventDefault();
    run(event.submitter, async () => {if (!$('account-key').value.trim()) throw new Error('Введите ключ OpenRouter.');await request('/api/key','PUT',{api_key:$('account-key').value.trim()});$('account-key').value='';$('account-key-form').hidden=true;update({...user,has_api_key:true});}, $('key-save-status'));
  };
  $('account-delete-key').onclick = event => run(event.target, async () => {
    if (!confirm('Удалить сохранённый ключ OpenRouter?')) return;
    await request('/api/key','DELETE');update({...user,has_api_key:false});
  });
  $('logout').onclick = event => run(event.target, async () => {await request('/api/auth/logout','POST');location.href='/';});

  function focusModelWithoutOpening() {if(document.activeElement !== modelInput){suppressModelFocus=true;modelInput.focus();}}
  function closeModels() {modelOpenIntent=false;options.hidden=true;modelInput.setAttribute('aria-expanded','false');}
  function renderModels() {
    modelOpenIntent=true;
    const query=modelInput.value.trim().toLowerCase();options.replaceChildren();
    const matches=models.filter(model=>(model.id+' '+model.name).toLowerCase().includes(query)).slice(0,40);
    for (const model of matches) {
      const item=document.createElement('button');item.type='button';item.role='option';item.setAttribute('aria-selected',String(model.id===modelInput.value));
      const name=document.createElement('span');name.textContent=model.name || model.id;
      const meta=document.createElement('small');meta.textContent=model.id+(model.supports_images?' · Изображения':'');item.append(name,meta);
      item.onpointerdown=event=>event.preventDefault();
      item.onclick=()=>{modelInput.value=model.id;closeModels();focusModelWithoutOpening();$('model-save-status').textContent=catalogStale?fallbackMessage:'';};
      options.append(item);
    }
    if (!matches.length) {const empty=document.createElement('p');empty.className='field-help';empty.textContent=catalogStale?'Введите ID модели вручную.':models.length?'Ничего не найдено. Попробуйте другое название.':'Загружаем список моделей…';options.append(empty);}
    options.hidden=false;modelInput.setAttribute('aria-expanded','true');
  }
  async function loadModels() {
    if (modelsPromise) return modelsPromise;
    modelsPromise=request('/api/models').then(data=>{
      models=data.models || [];savedDefault=data.default_model;catalogStale=!!data.stale;
      if (!modelInput.value) modelInput.value=user?.default_model || savedDefault || '';
      if (catalogStale) $('model-save-status').textContent=fallbackMessage;
    }).catch(()=>{catalogStale=true;$('model-save-status').textContent=fallbackMessage;modelsPromise=null;});
    return modelsPromise;
  }
  modelInput.onfocus=()=>{if(suppressModelFocus){suppressModelFocus=false;return;}modelOpenIntent=true;loadModels().then(()=>{if (modelOpenIntent && document.activeElement===modelInput) renderModels();});};
  modelInput.oninput=()=>{$('model-save-status').textContent=catalogStale?fallbackMessage:'';renderModels();};
  modelInput.onkeydown=event=>{
    if (event.key==='Escape' && !options.hidden) {event.preventDefault();event.stopPropagation();closeModels();}
    else if (event.key==='ArrowDown') {event.preventDefault();if(options.hidden)renderModels();options.querySelector('button')?.focus();}
  };
  options.onkeydown=event=>{
    const buttons=[...options.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);
    if (event.key==='Escape') {event.preventDefault();event.stopPropagation();closeModels();focusModelWithoutOpening();}
    else if (event.key==='ArrowDown'||event.key==='ArrowUp') {event.preventDefault();buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
  };
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('.model-picker'))closeModels();});
  $('default-model-form').onsubmit=event=>{
    event.preventDefault();
    run($('save-default-model'), async () => {
      const choice=modelInput.value.trim();
      if (!choice) throw new Error('Выберите модель из списка.');
      const known=models.some(model=>model.id===choice) || choice===user?.default_model || choice===savedDefault;
      if (!known && (!catalogStale || choice.length>200 || !/^[\w.:-]+\/[\w.:-]+$/.test(choice))) throw new Error(catalogStale?'Укажите модель в формате provider/model (до 200 символов).':'Выберите модель из доступного списка OpenRouter.');
      const result=await request('/api/auth/preferences','PUT',{default_model:choice});update(result.user);closeModels();$('model-save-status').textContent='Сохранено. Используем для новых дуэлей и тренировки.';
    }, $('model-save-status'));
  };
  window.mathAccount = {get user() {return user;},open:openAccount,request};
  window.mathAccount.ready=request('/api/auth/me').then(result=>{update(result.user);return user;}).catch(error=>{$('account-error').textContent=error.message;return null;});
})();
