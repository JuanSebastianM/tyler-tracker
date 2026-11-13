// Applies the saved colour theme before first paint. Loaded as a classic (blocking) script from
// index.html right after the stylesheets, so the CSP needs no inline script and the default theme
// never flashes. It only reads what src/lib/theme.js wrote to localStorage (`tt.theme.active`);
// theme.js takes over once the app boots. Keep THEMES and MODES in sync with theme.js.
(function () {
  var THEMES = ['default', 'rose', 'lavender', 'mint', 'sky'];
  var MODES = ['auto', 'light', 'dark'];
  var saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('tt.theme.active') || 'null');
  } catch (e) {
    saved = null;
  }
  var theme = saved && THEMES.indexOf(saved.theme) >= 0 ? saved.theme : 'default';
  var mode = saved && MODES.indexOf(saved.mode) >= 0 ? saved.mode : 'auto';
  var dark = mode === 'dark' || (mode === 'auto' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-mode', mode);
  root.setAttribute('data-scheme', dark ? 'dark' : 'light');
  try {
    var bg = getComputedStyle(root).getPropertyValue('--c-bg').trim();
    if (bg) {
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', bg);
    }
  } catch (e) {
    /* theme-color is cosmetic */
  }
})();
