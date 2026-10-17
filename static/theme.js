/* Run before stylesheets so the first frame uses the chosen theme. */
(() => {
  let preference = 'system';
  try { preference = localStorage.getItem('math-theme') || 'system'; } catch {}
  if (!['system', 'light', 'dark'].includes(preference)) preference = 'system';
  const media = matchMedia('(prefers-color-scheme: dark)');
  function apply() { document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference; }
  window.mathTheme = { get value() { return preference; }, set(value) { preference = value; try { localStorage.setItem('math-theme', value); } catch {} apply(); } };
  media.addEventListener('change', apply);
  window.addEventListener('storage', event => { if (event.key === 'math-theme') { preference = ['light', 'dark'].includes(event.newValue) ? event.newValue : 'system'; apply(); } });
  apply();
})();
