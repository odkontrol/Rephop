// Runs before the page is drawn, so someone who chose light mode never sees a dark flash.
try {
  const saved = localStorage.getItem('rhTheme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch (_) {
  /* private mode: the default (dark) stays until settings load */
}
