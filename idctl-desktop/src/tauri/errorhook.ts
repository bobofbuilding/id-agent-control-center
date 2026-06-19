// Imported FIRST so it catches errors during later module evaluation too.
function showError(msg: string): void {
  const d = document.createElement('div');
  d.style.cssText =
    'position:fixed;inset:0;z-index:99999;background:#1c1016;color:#f85149;padding:20px;font:12px monospace;white-space:pre-wrap;overflow:auto';
  d.textContent = 'ERROR:\n' + msg;
  (document.body || document.documentElement).appendChild(d);
}
window.addEventListener('error', (e) => showError(e.message + '\n' + ((e as ErrorEvent).error?.stack ?? '')));
window.addEventListener('unhandledrejection', (e) => showError('promise: ' + String((e as PromiseRejectionEvent).reason)));
