/* Shared account settings. Secrets never enter browser storage. */
(() => {
  let user = null;
  async function request(path, method = 'GET', body) {
    const response = await fetch(path, {method, credentials:'same-origin', headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : data.detail?.map(e => e.msg).join('; ') || 'Не удалось выполнить запрос.');
    return data;
  }
  function mount() {
    const shell = document.getElementById('account-shell');
    shell.innerHTML = `<dialog id="account-dialog" aria-labelledby="account-title"><form id="account-form"><div class="dialog-heading"><h2 id="account-title">Вход</h2><button type="button" id="close-account" aria-label="Закрыть">×</button></div><p class="muted" id="account-description">История задач и настройки сохраняются в вашем аккаунте.</p><div id="auth-fields"><label for="account-login">Логин</label><input id="account-login" autocomplete="username" required maxlength="64"><div id="register-fields" hidden><label for="account-name">Как вас называть</label><input id="account-name" autocomplete="nickname" maxlength="40"></div><label for="account-password">Пароль</label><input id="account-password" type="password" autocomplete="current-password" required><small id="password-help" hidden>От 8 символов. Логин: латинские буквы, цифры, _, . и -.</small></div><p id="account-error" class="error" role="alert"></p><button id="account-submit" type="submit" class="primary">Войти</button><button id="switch-auth" type="button" class="quiet">Создать аккаунт</button></form><div id="signed-settings" hidden><p id="signed-name"></p><form id="account-key-form"><label for="account-key">OpenRouter</label><p id="account-key-state" class="muted"></p><input id="account-key" type="password" placeholder="Новый ключ sk-or-…" autocomplete="off" maxlength="512"><small>Ключ сохраняется зашифрованным. Его не нужно вводить перед каждой игрой.</small><div class="dialog-actions"><button type="submit">Сохранить ключ</button><button type="button" id="account-delete-key">Удалить ключ</button></div></form><button id="logout" type="button" class="quiet">Выйти из аккаунта</button></div><label for="theme-mode">Оформление</label><select id="theme-mode"><option value="system">Как в системе</option><option value="light">Светлое</option><option value="dark">Тёмное</option></select></dialog>`;
    const $ = id => document.getElementById(id);
    let register = false;
    $('theme-mode').value = window.mathTheme.value;
    $('theme-mode').onchange = event => window.mathTheme.set(event.target.value);
    $('open-settings').onclick = () => $('account-dialog').showModal();
    $('close-account').onclick = () => $('account-dialog').close();
    $('switch-auth').onclick = () => { register = !register; $('register-fields').hidden = !register; $('password-help').hidden = !register; $('account-name').required = register; $('account-password').minLength = register ? 8 : 1; $('account-password').autocomplete = register ? 'new-password' : 'current-password'; $('account-title').textContent = register ? 'Создать аккаунт' : 'Вход'; $('account-submit').textContent = register ? 'Создать аккаунт' : 'Войти'; $('switch-auth').textContent = register ? 'Уже есть аккаунт' : 'Создать аккаунт'; };
    function update(next) { user = next; $('auth-fields').hidden = !!user; $('signed-settings').hidden = !user; $('account-submit').hidden = !!user; $('switch-auth').hidden = !!user; $('account-title').textContent = user ? 'Настройки' : 'Вход'; if (user) { $('signed-name').textContent = user.display_name; $('account-key-state').textContent = user.has_api_key ? 'Подключён · ключ сохранён' : 'Подключите ключ для проверки решений'; $('account-delete-key').hidden = !user.has_api_key; } window.dispatchEvent(new CustomEvent('accountchange', {detail:user})); }
    async function run(button, callback) { button.disabled = true; $('account-error').textContent = ''; try { await callback(); } catch(e) { $('account-error').textContent = e.message; } finally { button.disabled = false; } }
    $('account-form').onsubmit = event => { event.preventDefault(); run($('account-submit'), async () => { const result = await request(`/api/auth/${register ? 'register' : 'login'}`, 'POST', {login:$('account-login').value, password:$('account-password').value, ...(register ? {display_name:$('account-name').value} : {})}); $('account-password').value = ''; update(result.user); $('account-dialog').close(); location.reload(); }); };
    $('account-key-form').onsubmit = event => {event.preventDefault(); run(event.submitter, async () => { if (!$('account-key').value.trim()) throw new Error('Введите ключ OpenRouter.'); await request('/api/key', 'PUT', {api_key:$('account-key').value.trim()}); $('account-key').value = ''; update({...user, has_api_key:true}); });};
    $('account-delete-key').onclick = event => run(event.target, async () => {if (!confirm('Удалить сохранённый ключ OpenRouter?')) return; await request('/api/key','DELETE'); update({...user,has_api_key:false});});
    $('logout').onclick = event => run(event.target, async () => {await request('/api/auth/logout','POST'); location.href='/';});
    window.mathAccount = { get user() {return user;}, open() {$('account-dialog').showModal();}, request };
    window.mathAccount.ready = request('/api/auth/me').then(result => {update(result.user); return user;}).catch(error => {$('account-error').textContent=error.message; return null;});
  }
  mount();
})();
