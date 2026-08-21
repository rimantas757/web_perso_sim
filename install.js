/* Install page — grabs personalise.user.js just to display size/version so
 * users know the button links to a fresh, non-empty file. That's all this
 * needs to do; Tampermonkey handles the actual install flow via the .user.js
 * MIME/extension convention.
 */
(function () {
  const stats = document.getElementById('install-stats');
  if (!stats) return;

  fetch('./personalise.user.js', { cache: 'no-cache' })
    .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(src => {
      const versionMatch = src.match(/@version\s+(\S+)/);
      const version = versionMatch ? versionMatch[1] : 'unknown';
      const kb = (new Blob([src]).size / 1024).toFixed(1);
      stats.innerHTML = `Version <b>${version}</b> · ${kb} KB`;
    })
    .catch(err => {
      stats.textContent = 'Could not read userscript: ' + err.message;
    });
})();
