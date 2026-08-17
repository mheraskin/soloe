(() => {
  const storedMode = localStorage.getItem('mode-watcher-mode');
  const mode = storedMode === 'light' || storedMode === 'dark' || storedMode === 'system'
    ? storedMode
    : 'system';
  const dark = mode === 'dark'
    || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0f0f10' : '#f7f8fa');
})();
