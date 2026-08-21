/* Install page — fetches personalise.js at runtime, builds both bookmarklet
 * variants, and wires the copy-to-clipboard fallback.
 *
 * We regenerate everything on every page load, so pushing a new personalise.js
 * to the repo means both bookmarklets automatically point at the latest engine
 * on next page view — the drag-target updates itself.
 *
 * Loader bookmarklet points at the *same directory* as this page. On GitHub
 * Pages that's `https://{user}.github.io/{repo}/personalise.js`. If you host
 * elsewhere, no code change needed — the URL follows install.html.
 */
(function () {
  const enginePath = 'personalise.js';
  const loaderLink = document.getElementById('bm-loader');
  const inlineLink = document.getElementById('bm-inline');
  const loaderStatus = document.getElementById('loader-status');
  const inlineStatus = document.getElementById('inline-status');
  const loaderSrc = document.getElementById('loader-src');
  const inlineSrc = document.getElementById('inline-src');
  const sizeInfo = document.getElementById('size-info');
  const copyBtn = document.getElementById('copy-snippet');
  const copyStatus = document.getElementById('copy-status');
  const toast = document.getElementById('toast');

  let engineSource = null;

  function showToast(msg, ms) {
    toast.textContent = msg;
    toast.classList.add('is-show');
    setTimeout(() => toast.classList.remove('is-show'), ms || 1800);
  }

  // Absolute URL to personalise.js in the same directory as this HTML file.
  function engineUrl() {
    return new URL(enginePath, window.location.href).href;
  }

  // Loader bookmarklet — small: creates a <script> tag pointing at the hosted
  // engine and appends it. Cache-buster ensures the newest version runs each
  // time. onerror surfaces a helpful message so the user knows to try inline.
  function buildLoaderBookmarklet() {
    const url = engineUrl();
    const body = `
      var s=document.createElement('script');
      s.src=${JSON.stringify(url)}+'?_='+Date.now();
      s.onerror=function(){alert('Blocked by this site\\'s Content Security Policy.\\n\\nGo back to the Personalise install page and use the Inline bookmarklet instead.');};
      document.documentElement.appendChild(s);
    `.replace(/\s+/g, ' ').trim();
    return 'javascript:' + encodeURIComponent('(function(){' + body + '})();');
  }

  // Inline bookmarklet — bulky: whole engine wrapped in an IIFE. To sidestep
  // the fact that the engine source contains apostrophes/backticks/etc, we
  // base64-encode it and decode+eval on click. Result is a single bookmarklet
  // that carries the whole engine without touching the network at click time.
  function buildInlineBookmarklet(source) {
    // Strip the source's leading /* … */ header comment to keep size down.
    let src = source.replace(/^\/\*[\s\S]*?\*\/\s*/, '');
    // Simple whitespace/comment squash — enough to save ~30% without breaking
    // string literals. We deliberately do NOT run a full minifier client-side
    // to avoid dragging in a dependency.
    src = squashJs(src);
    // btoa can't handle Unicode directly; encodeURIComponent+unescape hack.
    const b64 = btoa(unescape(encodeURIComponent(src)));
    const body = `eval(decodeURIComponent(escape(atob('${b64}'))));`;
    return 'javascript:' + encodeURIComponent('(function(){' + body + '})();');
  }

  // Line-level squash: remove full-line // comments, /* … */ blocks that
  // span whole lines, and collapse runs of whitespace outside strings. This
  // is a conservative pass — it won't mangle strings or regexes because it
  // walks character-by-character with mode tracking.
  function squashJs(src) {
    let out = '';
    let i = 0, n = src.length;
    let inString = null; // char that opened the string, or null
    let inLineComment = false, inBlockComment = false;
    let lastWasSpace = false;
    while (i < n) {
      const c = src[i], next = src[i + 1];
      if (inLineComment) {
        if (c === '\n') { inLineComment = false; if (out.length && out[out.length - 1] !== ' ') { out += ' '; lastWasSpace = true; } }
        i++; continue;
      }
      if (inBlockComment) {
        if (c === '*' && next === '/') { inBlockComment = false; i += 2; if (out.length && out[out.length - 1] !== ' ') { out += ' '; lastWasSpace = true; } continue; }
        i++; continue;
      }
      if (inString) {
        out += c; lastWasSpace = false;
        if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
        if (c === inString) inString = null;
        i++; continue;
      }
      if (c === '/' && next === '/') { inLineComment = true; i += 2; continue; }
      if (c === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { inString = c; out += c; lastWasSpace = false; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        if (!lastWasSpace && out.length) { out += ' '; lastWasSpace = true; }
        i++; continue;
      }
      out += c; lastWasSpace = false; i++;
    }
    return out.trim();
  }

  function bytesLabel(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  async function init() {
    // Fetch the engine source
    try {
      const res = await fetch(enginePath, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      engineSource = await res.text();
    } catch (err) {
      loaderStatus.textContent = 'Failed to load engine: ' + err.message;
      inlineStatus.textContent = 'Failed to load engine.';
      return;
    }

    const rawSize = new Blob([engineSource]).size;
    sizeInfo.textContent = bytesLabel(rawSize) + ' raw';

    // Loader bookmarklet
    const loaderHref = buildLoaderBookmarklet();
    loaderLink.setAttribute('href', loaderHref);
    loaderLink.classList.remove('is-disabled');
    loaderSrc.textContent = loaderHref;
    loaderStatus.textContent = 'Ready · ' + bytesLabel(loaderHref.length) + ' · loads from ' + new URL(engineUrl()).host;

    // Inline bookmarklet
    const inlineHref = buildInlineBookmarklet(engineSource);
    inlineLink.setAttribute('href', inlineHref);
    inlineLink.classList.remove('is-disabled');
    inlineSrc.textContent = inlineHref;
    const size = bytesLabel(inlineHref.length);
    let sizeNote = '';
    if (inlineHref.length > 300000) sizeNote = ' · ⚠ very long, some browsers may truncate';
    else if (inlineHref.length > 100000) sizeNote = ' · large but OK in Chrome/Edge/Safari';
    inlineStatus.textContent = 'Ready · ' + size + sizeNote;

    // Enable drag-only for both
    for (const a of [loaderLink, inlineLink]) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        showToast('This is a bookmarklet — drag it to your bookmarks bar, don\'t click it here', 2400);
      });
    }

    // Copy DevTools snippet button
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(engineSource);
        copyStatus.textContent = 'Copied ' + bytesLabel(rawSize) + ' to clipboard';
        showToast('Engine copied to clipboard — paste into DevTools console');
        setTimeout(() => copyStatus.textContent = '', 4000);
      } catch (err) {
        copyStatus.textContent = 'Copy failed: ' + err.message;
      }
    });
  }

  init();
})();
