/* Install page — parses the target-site URL, rewrites @match in the fetched
 * userscript, and opens the resulting per-site variant in a new tab. When
 * Tampermonkey is installed, it picks up the .user.js content and offers
 * to install with the scoped @match line intact.
 *
 * We keep it all client-side because GitHub Pages is static hosting.
 */
(function () {
  const urlInput = document.getElementById('site-url');
  const preview = document.getElementById('preview');
  const installBtn = document.getElementById('install-btn');
  const installStats = document.getElementById('install-stats');
  const presetContainer = document.getElementById('presets');

  let engineSource = null;
  let scope = 'domain'; // 'hostname' | 'domain' | 'any'

  function setStats(text) { installStats.innerHTML = text; }
  function setEnabled(on) {
    if (on) installBtn.classList.remove('is-disabled');
    else installBtn.classList.add('is-disabled');
  }

  // Parse the input into a hostname. Accepts bare hostnames too ("audleytravel.com").
  function parseHost(raw) {
    if (!raw || !raw.trim()) return null;
    let s = raw.trim();
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      if (!u.hostname) return null;
      return u.hostname.toLowerCase();
    } catch (e) { return null; }
  }

  // Build the @match line(s) for the chosen scope.
  function matchesFor(host, scopeKind) {
    if (scopeKind === 'any' || !host) return ['*://*/*'];
    if (scopeKind === 'hostname') return [`*://${host}/*`];
    // 'domain' — strip a leading www. and also match subdomains
    const bare = host.replace(/^www\./, '');
    return [`*://${bare}/*`, `*://*.${bare}/*`];
  }

  function updatePreview() {
    const host = parseHost(urlInput.value);
    if (scope === 'any') {
      preview.classList.remove('is-error');
      preview.innerHTML = 'Will run on: <code>*://*/*</code> (every website).';
      setEnabled(!!engineSource);
      urlInput.classList.remove('is-error');
      return;
    }
    if (!host) {
      preview.classList.add('is-error');
      preview.textContent = urlInput.value.trim()
        ? 'That doesn\'t look like a valid URL.'
        : 'Enter a URL above to see the match pattern.';
      urlInput.classList.toggle('is-error', !!urlInput.value.trim());
      setEnabled(false);
      return;
    }
    preview.classList.remove('is-error');
    urlInput.classList.remove('is-error');
    const matches = matchesFor(host, scope);
    preview.innerHTML = 'Will run on: ' + matches.map(m => `<code>${m}</code>`).join(' and ');
    setEnabled(!!engineSource);
  }

  // Rewrite the userscript's @match line(s) to whatever we computed.
  function rewriteMatches(source, matches) {
    // Split off the metadata block; leave the engine body untouched.
    const metaEnd = source.indexOf('// ==/UserScript==');
    if (metaEnd === -1) return source; // shouldn't happen, but pass through
    const head = source.slice(0, metaEnd);
    const tail = source.slice(metaEnd);
    // Drop all existing @match lines and inject ours.
    const stripped = head.split('\n').filter(line => !/^\/\/\s*@match\s+/.test(line));
    const insertAt = stripped.findIndex(line => /^\/\/\s*@description\s+/.test(line));
    const matchLines = matches.map(m => `// @match        ${m}`);
    const idx = insertAt >= 0 ? insertAt + 1 : stripped.length;
    stripped.splice(idx, 0, ...matchLines);
    return stripped.join('\n') + tail;
  }

  // Keep the last-built scoped source so the fallback flow can reach it.
  let lastScopedSource = null;

  function buildScopedSource() {
    if (!engineSource) return null;
    const host = parseHost(urlInput.value);
    if (scope !== 'any' && !host) { updatePreview(); return null; }
    const matches = matchesFor(host, scope);
    return rewriteMatches(engineSource, matches);
  }

  function installPerSite() {
    const scoped = buildScopedSource();
    if (!scoped) return;
    lastScopedSource = scoped;

    // Primary path: create an anchor with download="personalise.user.js" and
    // click it. Because the destination filename ends in .user.js, Tampermonkey's
    // download interceptor recognises it and offers the install dialog even
    // though the URL itself is a blob: URL.
    const blob = new Blob([scoped], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'personalise.user.js';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);

    // Reveal the fallback panel — the user may or may not need it depending
    // on their browser + Tampermonkey combo.
    revealFallback();
  }

  function revealFallback() {
    let fb = document.getElementById('install-fallback');
    if (!fb) return;
    fb.style.display = 'block';
  }

  async function copyScopedToClipboard(btn) {
    const scoped = lastScopedSource || buildScopedSource();
    if (!scoped) return;
    try {
      await navigator.clipboard.writeText(scoped);
      const orig = btn.textContent;
      btn.textContent = 'Copied ✓ — now paste in Tampermonkey';
      setTimeout(() => btn.textContent = orig, 3000);
    } catch (err) {
      // Fallback for older browsers: put in a textarea and select it
      const ta = document.createElement('textarea');
      ta.value = scoped; ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); btn.textContent = 'Copied ✓'; }
      catch (e) { alert('Could not copy — select the code manually.'); }
      ta.remove();
    }
  }

  // -------------------- Boot --------------------
  fetch('./personalise.user.js', { cache: 'no-cache' })
    .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(src => {
      engineSource = src;
      const versionMatch = src.match(/@version\s+(\S+)/);
      const version = versionMatch ? versionMatch[1] : 'unknown';
      const kb = (new Blob([src]).size / 1024).toFixed(1);
      setStats(`Version <b>${version}</b> · ${kb} KB`);
      updatePreview();
    })
    .catch(err => {
      setStats('Could not read userscript: ' + err.message);
    });

  urlInput.addEventListener('input', updatePreview);
  urlInput.addEventListener('paste', () => setTimeout(updatePreview, 0));
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !installBtn.classList.contains('is-disabled')) {
      e.preventDefault(); installPerSite();
    }
  });

  presetContainer.addEventListener('click', (e) => {
    const t = e.target.closest('.preset');
    if (!t) return;
    scope = t.dataset.scope;
    for (const p of presetContainer.querySelectorAll('.preset')) p.classList.toggle('is-active', p === t);
    updatePreview();
  });

  installBtn.addEventListener('click', installPerSite);

  const fbCopyBtn = document.getElementById('fb-copy');
  const fbOpenBtn = document.getElementById('fb-open');
  if (fbCopyBtn) fbCopyBtn.addEventListener('click', () => copyScopedToClipboard(fbCopyBtn));
  if (fbOpenBtn) fbOpenBtn.addEventListener('click', () => {
    // Tampermonkey's "add new script" page opens differently per browser and
    // per install; we can't reliably link to it. Guide the user to the
    // Tampermonkey icon in their toolbar instead. But we can open the docs
    // page which has a screenshot of exactly where to click.
    window.open('https://www.tampermonkey.net/faq.php#Q102', '_blank', 'noopener');
  });

  updatePreview();
})();
