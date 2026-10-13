// ==UserScript==
// @name         Personalise (rimantas757/web_perso_sim)
// @namespace    https://rimantas757.github.io/web_perso_sim
// @version      2026.10.13.1904
// @description  Client-side personalisation engine — tag pages, score topics, replace heroes/banners by named slot, fire swap/popup/script actions.
// @author       rimantas757
// @match        *://*/*
// @run-at       document-start
// Scope is managed at RUNTIME via an allowlist (survives updates), not @match.
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @updateURL    https://rimantas757.github.io/web_perso_sim/personalise.user.js
// @downloadURL  https://rimantas757.github.io/web_perso_sim/personalise.user.js
// @supportURL   https://github.com/rimantas757/web_perso_sim/issues
// @homepageURL  https://github.com/rimantas757/web_perso_sim
// ==/UserScript==

/* ============================================================
 * Personalise.js \u2014 reusable client-side personalisation engine
 * ============================================================
 * v2: generic engine + config mode
 *
 * Two modes, one toggle on the panel:
 *   - Runtime : scores current visit against saved URL rules, fires
 *               threshold rules, shows tag scores + fired rules
 *   - Config  : browse the site, tag any page with a topic + weight,
 *               manage topics, edit URL patterns, export/import JSON
 *
 * All config lives in localStorage under a single key so it survives
 * reloads and can be exported to move between environments.
 *
 * Works on SPAs: patches history.pushState/replaceState + listens for
 * popstate, re-scores + re-renders on every route change.
 * ============================================================ */

(function () {
  if (window.__personaliseLoaded) {
    console.info('[personalise] already loaded, skipping');
    return;
  }
  window.__personaliseLoaded = true;

  const CONFIG_STORAGE_KEY = 'personalise::config';
  const STATE_STORAGE_KEY = 'personalise::state';
  const UI_STORAGE_KEY = 'personalise::ui';

  // -------------------- Default config --------------------
  // Generic \u2014 no client-specific rules. User builds up rules in Config mode.
  function defaultConfig() {
    return {
      client: 'Generic',
      avatarUrl: '',
      topics: [
        { id: 'topic-1', label: 'Topic 1' },
        { id: 'topic-2', label: 'Topic 2' },
        { id: 'topic-3', label: 'Topic 3' }
      ],
      urlRules: [
        // { id, pattern: string, kind: 'exact'|'prefix'|'regex', topicId, weight }
      ],
      thresholdRules: [
        // { id, description, topicId, threshold, appliesOn: [{ pattern, kind }], action: { type, ... } }
      ]
    };
  }

  // Curated persona avatar library. URL is what shows inside the badge.
  const PERSONA_LIBRARY = [
    { name: 'Priya',   url: 'https://res.cloudinary.com/dt9axinn5/image/upload/v1774959110/Pria_profile_icon_y3hm4k.png' },
    { name: 'Maya',    url: 'https://res.cloudinary.com/dt9axinn5/image/upload/v1774959111/Maya_profiel_icon_vsvtjg.png' },
    { name: 'Nina',    url: 'https://res.cloudinary.com/dt9axinn5/image/upload/v1774959110/Nina_profile_icon_jm6efs.png' },
    { name: 'Amanda',  url: 'https://res.cloudinary.com/dt9axinn5/image/upload/v1775038004/Whatsapp_profile_Amanda_professional_ccxxdj.png' },
    { name: 'Tim',     url: 'https://res.cloudinary.com/dt9axinn5/image/upload/v1775038004/Whatsapp_profile_Tim_professional_y1rfof.png' },
    { name: 'Andrew',  url: 'https://res.cloudinary.com/dt9axinn5/image/upload/v1775038003/Whatsapp_profile_Andrew_j456oh.png' }
  ];

  function togglePersonaLibrary(anchor, targetInput) {
    // Toggle: if a popover is already up next to this anchor, close it.
    const existing = document.querySelector('.pp-persona-popover');
    if (existing) { existing.remove(); return; }
    const pop = document.createElement('div');
    pop.className = 'pp-persona-popover';
    for (const p of PERSONA_LIBRARY) {
      const choice = document.createElement('button');
      choice.className = 'pp-persona-choice';
      choice.type = 'button';
      const img = document.createElement('img'); img.src = p.url; img.alt = p.name;
      const name = document.createElement('span'); name.textContent = p.name;
      choice.appendChild(img); choice.appendChild(name);
      choice.addEventListener('click', (e) => {
        e.stopPropagation();
        targetInput.value = p.url;
        config.avatarUrl = p.url;
        saveConfig();
        pop.remove();
        renderPanel();
      });
      pop.appendChild(choice);
    }
    // Attach to the row, not to the button, so it can span wider
    anchor.parentElement.appendChild(pop);
    // Dismiss on outside click
    setTimeout(() => {
      const off = (e) => { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('mousedown', off, true); } };
      document.addEventListener('mousedown', off, true);
    }, 0);
  }

  // -------------------- Storage helpers --------------------
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return fallback;
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  // -------------------- Site allowlist (update-proof scoping) --------------------
  // Scope is stored as DATA, not in the script's @match metadata — so a
  // Tampermonkey auto-update (which rewrites @match from the published file)
  // can't reset it. Prefer Tampermonkey's cross-origin GM storage so the
  // allowlist is shared across sites; fall back to localStorage when the engine
  // runs without GM (install-page injection, bookmarklet, tests).
  const SITES_STORAGE_KEY = 'personalise::sites';
  function ppGet(key, fallback) {
    try { if (typeof GM_getValue === 'function') { const v = GM_getValue(key); return v === undefined ? fallback : v; } } catch (e) { /* ignore */ }
    return loadJSON(key, fallback);
  }
  function ppSet(key, value) {
    try { if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; } } catch (e) { /* ignore */ }
    saveJSON(key, value);
  }
  function getAllowedSites() { const v = ppGet(SITES_STORAGE_KEY, []); return Array.isArray(v) ? v : []; }
  function setAllowedSites(list) { ppSet(SITES_STORAGE_KEY, list); }
  // A stored entry matches the current host exactly, or as a parent domain
  // (entry "audleytravel.com" matches "www.audleytravel.com").
  function hostMatchesEntry(host, entry) {
    if (!host || !entry) return false;
    host = host.toLowerCase(); entry = entry.toLowerCase().replace(/^www\./, '');
    return host === entry || host.endsWith('.' + entry);
  }
  function siteAllowed(host) { return getAllowedSites().some(e => hostMatchesEntry(host, e)); }
  function currentHostAllowed() { return siteAllowed(window.location.hostname); }
  function addCurrentSite() {
    const bare = (window.location.hostname || '').toLowerCase().replace(/^www\./, '');
    if (!bare) return;
    const list = getAllowedSites();
    if (!list.includes(bare)) { list.push(bare); setAllowedSites(list); }
  }
  function removeSite(entry) {
    setAllowedSites(getAllowedSites().filter(e => e !== entry));
  }
  function toggleCurrentSite() {
    if (currentHostAllowed()) {
      // Remove any entry that matches the current host.
      const host = window.location.hostname;
      setAllowedSites(getAllowedSites().filter(e => !hostMatchesEntry(host, e)));
    } else {
      addCurrentSite();
    }
    location.reload();
  }
  // Reachable from non-GM contexts (and tests) where there's no Tampermonkey menu.
  try {
    window.personaliseEnableHere = () => { addCurrentSite(); location.reload(); };
    window.personaliseDisableHere = () => { toggleCurrentSite(); };
  } catch (e) { /* ignore */ }

  let config = loadJSON(CONFIG_STORAGE_KEY, null);
  if (!config) { config = defaultConfig(); saveJSON(CONFIG_STORAGE_KEY, config); }
  let state = loadJSON(STATE_STORAGE_KEY, { scores: {}, firedRules: [], scoredUrls: [] });
  let ui = loadJSON(UI_STORAGE_KEY, { mode: 'runtime', collapsed: false });
  // Claude Gateway connection (per-SE machine settings — kept in `ui` so they
  // are NOT exported with a story and NOT clobbered by importing one).
  if (!ui.gateway) ui.gateway = { url: 'http://localhost:4000', key: '' };

  function saveConfig() { saveJSON(CONFIG_STORAGE_KEY, config); }
  function saveState() { saveJSON(STATE_STORAGE_KEY, state); }
  function saveUi() { saveJSON(UI_STORAGE_KEY, ui); }

  // -------------------- URL matching --------------------
  function patternMatches(pattern, kind, url, path) {
    if (kind === 'exact') return path === pattern || url === pattern;
    if (kind === 'prefix') {
      // Prefix ends in "*" \u2014 strip and check
      const p = pattern.replace(/\*+$/, '');
      return path.startsWith(p) || url.startsWith(p);
    }
    if (kind === 'regex') {
      try {
        // Pattern format: /body/flags OR body
        const m = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
        const rx = m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
        return rx.test(url) || rx.test(path);
      } catch (e) { return false; }
    }
    return false;
  }

  // -------------------- Scoring --------------------
  // We score at most once per unique URL to avoid runaway inflation on
  // SPA route changes / reloads. Users can Reset to clear scoredUrls.
  function scoreCurrentPage() {
    const url = window.location.href;
    const path = window.location.pathname || '/';
    if (state.scoredUrls.includes(url)) return false;

    let changed = false;
    for (const rule of config.urlRules) {
      if (patternMatches(rule.pattern, rule.kind, url, path)) {
        state.scores[rule.topicId] = (state.scores[rule.topicId] || 0) + (rule.weight || 1);
        changed = true;
        console.info(`[personalise] +${rule.weight} to ${rule.topicId} (total ${state.scores[rule.topicId]}) via ${rule.pattern}`);
      }
    }
    if (changed) {
      state.scoredUrls.push(url);
      saveState();
    }
    return changed;
  }

  // -------------------- Threshold actions --------------------
  // Every action gets (rule, ctx). ctx exposes safe helpers for runScript
  // authors so a snippet doesn't have to bring its own utilities.
  function makeCtx() {
    return {
      $: (sel) => document.querySelector(sel),
      $$: (sel) => Array.from(document.querySelectorAll(sel)),
      state,
      config,
      log: (...a) => console.info('[personalise:script]', ...a)
    };
  }

  // -------------------- Named personalization slots --------------------
  // Sites can expose stable, friendly targets with data-personalise="<name>"
  // (text/image elements) or data-personalise-section="<name>" (whole sections).
  // The SE picks these by name in the editor instead of typing a CSS selector.
  const SLOT_ATTR = 'data-personalise';
  const SLOT_SECTION_ATTR = 'data-personalise-section';

  // Discover every slot on the current page, de-duped by name, in DOM order.
  // Returns [{ name, label, kind: 'element'|'section', el }].
  function discoverSlots() {
    const out = [];
    const seen = new Set();
    const nodes = document.querySelectorAll(`[${SLOT_ATTR}],[${SLOT_SECTION_ATTR}]`);
    for (const el of nodes) {
      const sectionName = el.getAttribute(SLOT_SECTION_ATTR);
      const elementName = el.getAttribute(SLOT_ATTR);
      const name = elementName || sectionName;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, label: humanizeSlot(name), kind: elementName ? 'element' : 'section', el });
    }
    return out;
  }

  function humanizeSlot(name) {
    return String(name).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function findSlotEl(name) {
    if (!name) return null;
    return document.querySelector(
      `[${SLOT_ATTR}="${CSS.escape(name)}"],[${SLOT_SECTION_ATTR}="${CSS.escape(name)}"]`
    );
  }

  function hasBackgroundImage(el) {
    if (!(el instanceof Element)) return false;
    const bg = getComputedStyle(el).backgroundImage;
    return bg && bg !== 'none';
  }

  // Extract the first url(...) from a CSS background-image value.
  function bgImageUrl(el) {
    const bg = getComputedStyle(el).backgroundImage || '';
    const m = bg.match(/url\((['"]?)(.*?)\1\)/i);
    return m ? m[2] : '';
  }

  // First URL out of a srcset string ("a.jpg 350w, b.jpg 700w" -> "a.jpg").
  function firstFromSrcset(ss) {
    if (!ss) return '';
    const first = ss.split(',')[0].trim().split(/\s+/)[0];
    return first || '';
  }
  // Resolve the real image URL for an <img>, tolerating lazy-loaders: many
  // sites keep the actual URL in data-src/data-srcset and only populate src on
  // scroll. We read those NOW so the gallery shows the true image without the
  // user having to scroll it into view first.
  function resolveImgSrc(img) {
    const cur = img.currentSrc || img.getAttribute('src') || '';
    // A 1x1 / data: placeholder or empty src means it hasn't lazy-loaded yet.
    const placeholderish = !cur || /^data:/.test(cur) || /\b(blank|placeholder|spacer|1x1)\b/i.test(cur);
    if (!placeholderish) return cur;
    return img.getAttribute('data-src')
      || firstFromSrcset(img.getAttribute('data-srcset'))
      || firstFromSrcset(img.getAttribute('srcset'))
      || cur;
  }

  // Enumerate every image-bearing element on the page for the visual gallery:
  // <img> (resolving lazy data-src), elements with a background-image, and
  // <video poster> (common for hero banners). Skips our own panel/overlays,
  // tiny or hidden images, dedupes by element. Returns
  // [{ el, kind:'img'|'bg'|'video', src, w, h }], largest rendered area first.
  function collectPageImages() {
    const out = [];
    const seen = new Set();
    const MIN = 24; // px — ignore icons/tracking pixels
    function consider(el, kind, src) {
      if (!src || seen.has(el)) return;
      if (el.closest('#pp-panel, #pp-pick-overlay, #pp-pick-hint, #pp-ai-modal, #pp-image-gallery')) return;
      const r = el.getBoundingClientRect();
      // Fall back to natural/attribute size for elements not yet laid out.
      const w = Math.round(r.width) || (el.naturalWidth || parseInt(el.getAttribute('width'), 10) || 0);
      const h = Math.round(r.height) || (el.naturalHeight || parseInt(el.getAttribute('height'), 10) || 0);
      if (w < MIN || h < MIN) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      seen.add(el);
      out.push({ el, kind, src, w, h });
    }
    document.querySelectorAll('img').forEach(img => consider(img, 'img', resolveImgSrc(img)));
    // Video heroes: use the poster frame as the thumbnail/target.
    document.querySelectorAll('video[poster]').forEach(v => consider(v, 'video', v.getAttribute('poster')));
    document.querySelectorAll('*').forEach(node => {
      if (node.tagName === 'IMG' || node.tagName === 'VIDEO') return;
      if (hasBackgroundImage(node)) consider(node, 'bg', bgImageUrl(node));
    });
    out.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    return out;
  }

  // Detect repeating "card row" containers on the page — the natural homes for
  // a recommendations strip. A card row = a container with >=2 direct-child
  // elements that each contain an <img> AND a heading or link. We clone one of
  // these cards to make personalised recs blend into the site's own styling.
  function detectCardRows() {
    const rows = [];
    const containers = new Set();
    const vh = window.innerHeight || 800;
    // A real "card" holds exactly ONE image (not a nested group of cards) and a
    // bit of text. Walk up from each img to the nearest such ancestor.
    const cardish = Array.from(document.querySelectorAll('img')).map(img => {
      let n = img;
      for (let i = 0; i < 4 && n && n.parentElement; i++) {
        n = n.parentElement;
        // Stop as soon as this ancestor carries a heading/link (a card's content)
        // but still contains only ONE image — i.e. it's a single card, not a row
        // of cards or a whole section.
        if (n.querySelectorAll('img').length > 1) { n = null; break; }
        if (n.querySelector('h1,h2,h3,h4,h5,a,[class*="title"],[class*="content"]')) break;
      }
      return n;
    }).filter(Boolean);

    for (const card of cardish) {
      const parent = card.parentElement;
      if (!parent || containers.has(parent)) continue;
      if (parent.closest('#pp-panel, #pp-ai-modal, #pp-image-gallery')) continue;
      // Siblings that structurally match: same tag, each has exactly one <img>.
      const sibs = Array.from(parent.children).filter(c =>
        c.tagName === card.tagName && c.querySelectorAll('img').length === 1);
      if (sibs.length < 2) continue;
      // Reject if the "cards" are section-sized (a wrapper of carousels, etc.).
      const r0 = sibs[0].getBoundingClientRect();
      if (r0.height > vh * 0.7) continue;
      containers.add(parent);
      // Score: favour MORE cards; mild bonus for reasonable card size. Avoid
      // rewarding giant blocks (that's what picked the wrong wrapper before).
      rows.push({
        container: parent,
        cardEls: sibs,
        cardTag: card.tagName,
        count: sibs.length,
        score: sibs.length * 1000 + Math.min(r0.width * r0.height, 200000) / 1000
      });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  function detectBestCardRow() {
    const rows = detectCardRows();
    return rows.length ? rows[0] : null;
  }

  // Resolve a slot name to the concrete element to act on. `want` is 'text' or
  // 'image'. For images we handle the common pattern where the slot attribute
  // sits on a text node (h1/p) while the hero media is a sibling: search the
  // enclosing section for an <img> or a background-image element.
  function resolveSlotTarget(name, want) {
    const anchor = findSlotEl(name);
    if (!anchor) return null;
    if (want !== 'image') return anchor;
    // The attribute element itself carries the image?
    if (anchor.tagName === 'IMG' || hasBackgroundImage(anchor)) return anchor;
    // Otherwise look within the enclosing section for the hero media.
    const scope = anchor.closest(`[${SLOT_SECTION_ATTR}], section`) || anchor.parentElement || document.body;
    const media = scope.querySelector('[class*="__media"] img, [class*="__media"], img');
    if (media) return media;
    const bgEl = Array.from(scope.querySelectorAll('*')).find(hasBackgroundImage);
    return bgEl || anchor;
  }

  // Resolve the element a swapImage rule targets: slot wins over raw selector.
  function swapImageTargetEl(rule) {
    if (rule.action.slot) return resolveSlotTarget(rule.action.slot, 'image');
    if (rule.action.selector) return document.querySelector(rule.action.selector);
    return null;
  }

  // -------------------- Live HTML capture (for gatewayDesignScript) ----------
  // Clone document.body, strip our own panel + noise (scripts, styles, SVGs,
  // hidden elements), and return the cleaned innerHTML. This gives the agent the
  // REAL markup with real classes/attrs/text so it can write accurate selectors.
  function captureLiveHtml() {
    var clone = document.body.cloneNode(true);
    var ours = clone.querySelectorAll('#pp-panel, #pp-ai-modal, #pp-image-gallery, #pp-pick-overlay, #pp-pick-hint, #pp-preapply, [id^="personalise-"]');
    for (var i = 0; i < ours.length; i++) ours[i].remove();
    var noise = clone.querySelectorAll('script, style, noscript, iframe, link[rel="stylesheet"]');
    for (var j = 0; j < noise.length; j++) noise[j].remove();
    var svgs = clone.querySelectorAll('svg');
    for (var k = 0; k < svgs.length; k++) { svgs[k].textContent = ''; svgs[k].setAttribute('data-stripped', 'svg-contents'); }
    var allLive = document.body.querySelectorAll('*');
    var allClone = clone.querySelectorAll('*');
    for (var m = 0; m < allLive.length && m < allClone.length; m++) {
      try { var cs = getComputedStyle(allLive[m]); if (cs.display === 'none' || cs.visibility === 'hidden') allClone[m].remove(); } catch (e) {}
    }
    var styled = clone.querySelectorAll('[style]');
    for (var n = 0; n < styled.length; n++) styled[n].removeAttribute('style');
    return clone.innerHTML;
  }

  // -------------------- HTML sanitizer (for richPopup) --------------------
  // Best-effort containment for model-authored markup — same trust model as
  // runScript (SE runs this only on sites they're presenting). Parses in an
  // inert document, drops executable nodes/attrs, returns a DocumentFragment.
  function sanitizeHtml(htmlString) {
    const doc = new DOMParser().parseFromString(String(htmlString), 'text/html');
    const drop = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE']);
    const walk = (node) => {
      // Iterate over a static copy — we mutate as we go.
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 1) { // element
          if (drop.has(child.tagName)) { child.remove(); continue; }
          // Strip event handlers + javascript:/unsafe-data URLs.
          for (const attr of Array.from(child.attributes)) {
            const name = attr.name.toLowerCase();
            const val = attr.value || '';
            if (name.startsWith('on')) { child.removeAttribute(attr.name); continue; }
            if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(name)) {
              if (/^\s*javascript:/i.test(val)) { child.removeAttribute(attr.name); continue; }
              if (/^\s*data:/i.test(val) && !/^\s*data:image\//i.test(val)) { child.removeAttribute(attr.name); continue; }
            }
            if (name === 'style' && /(expression\(|url\(\s*['"]?\s*javascript:)/i.test(val)) {
              child.removeAttribute(attr.name); continue;
            }
          }
          walk(child);
        }
      }
    };
    walk(doc.body);
    const frag = document.createDocumentFragment();
    for (const n of Array.from(doc.body.childNodes)) frag.appendChild(n);
    return frag;
  }

  // Prefix every top-level selector in a CSS string with `scope` so model CSS
  // can't leak onto the host page. Naive but adequate: splits on rule braces.
  // Leaves @-rules (media/keyframes/font-face) alone so they still work.
  function scopeCss(cssString, scope) {
    const css = String(cssString);
    let out = '';
    let i = 0;
    while (i < css.length) {
      const open = css.indexOf('{', i);
      if (open === -1) { out += css.slice(i); break; }
      const selectorPart = css.slice(i, open);
      // Find the matching close brace (handles one level of nesting for @media).
      let depth = 1, j = open + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      const bodyPart = css.slice(open, j); // includes braces
      const sel = selectorPart.trim();
      if (sel.startsWith('@')) {
        // At-rule: scope the inner block's selectors, keep the at-rule wrapper.
        if (/^@(media|supports)/i.test(sel)) {
          const inner = bodyPart.slice(1, -1);
          out += sel + ' { ' + scopeCss(inner, scope) + ' }';
        } else {
          out += sel + ' ' + bodyPart; // keyframes/font-face: leave as-is
        }
      } else {
        const scoped = sel.split(',').map(s => s.trim()).filter(Boolean)
          .map(s => scope + ' ' + s).join(', ');
        out += scoped + ' ' + bodyPart;
      }
      i = j;
    }
    return out;
  }

  const actions = {
    // swapImage handles both <img> src and background-image on any element.
    // Target is a named slot (preferred) or a raw CSS selector (advanced).
    swapImage(rule) {
      const el = swapImageTargetEl(rule);
      if (!el) {
        const where = rule.action.slot ? `slot "${rule.action.slot}"` : `selector ${rule.action.selector}`;
        console.warn(`[personalise] swapImage target not found: ${where}`); return false;
      }
      // Video target: replace it WITH a video (swap the source + play), not an
      // image — a playing hero would cover any poster/background we set. Checked
      // BEFORE the image guard since video rules carry `video`, not `image`.
      if (el.tagName === 'VIDEO' || rule.action.isVideo) {
        const vurl = rule.action.video;
        if (!vurl) { console.warn('[personalise] swapImage: video target needs a video URL'); return false; }
        const v = el.tagName === 'VIDEO' ? el : (el.querySelector && el.querySelector('video'));
        if (!v) { console.warn('[personalise] swapImage: no <video> at target'); return false; }
        try { v.pause && v.pause(); } catch (e) { /* ignore */ }
        v.querySelectorAll('source').forEach(s => s.remove());
        v.removeAttribute('poster');
        v.src = vurl;
        v.muted = true; v.setAttribute('muted', '');
        v.setAttribute('autoplay', ''); v.setAttribute('playsinline', ''); v.loop = v.loop || true;
        try { v.load && v.load(); } catch (e) { /* ignore */ }
        try { const p = v.play && v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
        return true;
      }
      const image = rule.action.image;
      if (!image) { console.warn('[personalise] swapImage missing image'); return false; }
      if (el.tagName === 'IMG') {
        el.src = image;
        // Clear srcset AND lazy-loader attrs so neither re-overrides our swap.
        if (el.srcset) el.removeAttribute('srcset');
        el.removeAttribute('data-src'); el.removeAttribute('data-srcset');
        el.classList.remove('lazy');
      } else {
        el.style.backgroundImage = `url('${image}')`;
        el.style.backgroundSize = el.style.backgroundSize || 'cover';
      }
      return true;
    },
    // Legacy alias \u2014 old configs referenced swapBackground.
    swapBackground(rule) { return actions.swapImage(rule); },
    popup(rule) {
      if (document.getElementById('personalise-popup')) return true;
      const wrap = document.createElement('div');
      wrap.id = 'personalise-popup';
      const backdrop = document.createElement('div'); backdrop.className = 'pp-popup__backdrop';
      const box = document.createElement('div'); box.className = 'pp-popup__box';
      const closeBtn = document.createElement('button'); closeBtn.className = 'pp-popup__close';
      closeBtn.setAttribute('aria-label', 'Close'); closeBtn.textContent = '\u00D7';
      const title = document.createElement('h3'); title.textContent = rule.action.title || 'A message for you';
      const body = document.createElement('p'); body.textContent = rule.action.body || '';
      box.appendChild(closeBtn); box.appendChild(title); box.appendChild(body);
      if (rule.action.cta && rule.action.cta.href) {
        const cta = document.createElement('a');
        cta.className = 'pp-popup__cta'; cta.href = rule.action.cta.href;
        cta.textContent = rule.action.cta.label || 'Learn more';
        box.appendChild(cta);
      }
      wrap.appendChild(backdrop); wrap.appendChild(box);
      document.body.appendChild(wrap);
      closeBtn.addEventListener('click', () => wrap.remove());
      backdrop.addEventListener('click', () => wrap.remove());
      return true;
    },
    // LLM-designed, brand-aligned popup. Content is model-authored HTML + CSS
    // (so it can match any site and include a form). Same trust model as
    // runScript \u2014 we sanitize best-effort, scope the CSS, own the close +
    // form-submit so model markup can't navigate away or restyle the host page.
    richPopup(rule) {
      if (document.getElementById('personalise-richpopup')) return true;
      const html = rule.action.html;
      if (!html) { console.warn('[personalise] richPopup missing html'); return false; }

      const wrap = document.createElement('div'); wrap.id = 'personalise-richpopup';
      const backdrop = document.createElement('div'); backdrop.className = 'pp-rp__backdrop';
      const box = document.createElement('div'); box.className = 'pp-rp__box';

      // Scope the model's CSS under our wrapper id so it cannot restyle the host.
      if (rule.action.css) {
        const style = document.createElement('style');
        style.textContent = scopeCss(rule.action.css, '#personalise-richpopup .pp-rp__box');
        box.appendChild(style);
      }
      // Sanitized model markup \u2014 never raw innerHTML.
      const content = document.createElement('div'); content.className = 'pp-rp__content';
      content.appendChild(sanitizeHtml(html));
      box.appendChild(content);

      // We always own the close button (don't trust the model to add one).
      const closeBtn = document.createElement('button'); closeBtn.className = 'pp-rp__close';
      closeBtn.setAttribute('aria-label', 'Close'); closeBtn.textContent = '\u00d7';
      box.appendChild(closeBtn);

      wrap.appendChild(backdrop); wrap.appendChild(box);
      // Intercept ANY form submit inside the popup (capture) so a demo form never
      // navigates away \u2014 show a lightweight thank-you instead.
      wrap.addEventListener('submit', (e) => {
        e.preventDefault(); e.stopPropagation();
        const thanks = document.createElement('div'); thanks.className = 'pp-rp__thanks';
        thanks.textContent = 'Thanks \u2014 we\u2019ll be in touch.';
        content.replaceChildren(thanks);
      }, true);
      document.body.appendChild(wrap);
      closeBtn.addEventListener('click', () => wrap.remove());
      backdrop.addEventListener('click', () => wrap.remove());
      return true;
    },
    // Recommendations strip. Structured, editable cards (image + text lines).
    // Blends in by CLONING an existing card row on the page and swapping its
    // image/text (replace mode); falls back to a generic injected strip when
    // the page has no card row (add mode). Only textContent is set on clones —
    // no HTML injection. Idempotent + restorable (see restoreRecStrip).
    recStrip(rule) {
      const cards = Array.isArray(rule.action.cards) ? rule.action.cards : [];
      if (!cards.length) { console.warn('[personalise] recStrip has no cards'); return false; }

      // Resolve the target row: explicit selector, else auto-detect the best one.
      let row = null;
      if (rule.action.target) {
        try { const c = document.querySelector(rule.action.target); if (c) row = detectCardRows().find(r => r.container === c) || { container: c, cardEls: Array.from(c.children) }; } catch (e) { /* bad selector */ }
      }
      if (!row && rule.action.mode !== 'add') row = detectBestCardRow();

      if (row && rule.action.mode !== 'add') {
        return recStripReplace(rule, row, cards);
      }
      return recStripInject(rule, cards);
    },
    // Escape hatch: run an arbitrary JS snippet with access to a ctx helper bag.
    // Only run configs you trust \u2014 same trust model as a bookmarklet.
    runScript(rule) {
      const code = rule.action.code;
      if (!code) { console.warn('[personalise] runScript missing code'); return false; }
      try {
        const fn = new Function('rule', 'ctx', code);
        fn(rule, makeCtx());
        return true;
      } catch (err) {
        console.error('[personalise] runScript error:', err);
        return false;
      }
    }
  };

  // -------------------- recStrip helpers --------------------
  // Original innerHTML of each row we replaced, keyed by rule.id, so un-fire /
  // reset can put the site back exactly as it was.
  const __rsOriginals = new Map();

  // Fill one cloned card node from a {image, lines[]} spec, in place, setting
  // textContent only (no HTML injection). Maps lines onto the card's text
  // elements in document order.
  function fillCard(cardEl, spec) {
    const img = cardEl.querySelector('img');
    if (img && spec.image) { img.src = spec.image; if (img.hasAttribute('srcset')) img.removeAttribute('srcset'); img.removeAttribute('loading'); }
    const lines = Array.isArray(spec.lines) ? spec.lines.slice() : [];
    if (!lines.length) return;
    // Candidate text holders inside the card, in order. Prefer leaf-ish nodes.
    const holders = Array.from(cardEl.querySelectorAll('h1,h2,h3,h4,h5,p,span,a,div'))
      .filter(n => {
        if (n.querySelector('img')) return false;              // skip media wrappers
        if (n.children.length && n.textContent.trim() === '') return false;
        // leaf-ish: no element children, or only inline formatting
        return n.children.length === 0 || !n.querySelector('h1,h2,h3,h4,h5,p,div');
      });
    let li = 0;
    for (const h of holders) {
      if (li >= lines.length) break;
      h.textContent = lines[li++];
    }
  }

  // Replace an existing card row's children with cloned, filled cards. Stashes
  // the original once for restore.
  function recStripReplace(rule, row, cards) {
    const container = row.container;
    if (!container) return false;
    if (!__rsOriginals.has(rule.id)) __rsOriginals.set(rule.id, { html: container.innerHTML, selector: uniqueSelector(container) });
    const template = (row.cardEls && row.cardEls[0]) || container.firstElementChild;
    if (!template) return false;
    const frag = document.createDocumentFragment();
    for (const spec of cards) {
      const clone = template.cloneNode(true);
      fillCard(clone, spec);
      frag.appendChild(clone);
    }
    container.replaceChildren(frag);
    container.setAttribute('data-pp-recstrip', rule.id);
    // Demo safety: links inside the replaced row shouldn't navigate.
    container.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a, button');
      if (a && container.contains(a)) e.preventDefault();
    }, true);
    return true;
  }

  // Generic fallback strip when there's no existing card row to clone.
  function recStripInject(rule, cards) {
    const id = 'personalise-recstrip-' + rule.id;
    const prior = document.getElementById(id); if (prior) prior.remove();
    const wrap = document.createElement('div'); wrap.id = id; wrap.className = 'pp-rs';
    const content = document.createElement('div'); content.className = 'pp-rs__content';
    if (rule.action.heading) { const h = document.createElement('h3'); h.textContent = rule.action.heading; content.appendChild(h); }
    const cardsWrap = document.createElement('div'); cardsWrap.className = 'pp-rs__cards';
    for (const spec of cards) {
      const card = document.createElement('div'); card.className = 'pp-rs__card';
      if (spec.image) { const im = document.createElement('img'); im.src = spec.image; im.alt = ''; card.appendChild(im); }
      for (const line of (spec.lines || [])) { const p = document.createElement('div'); p.className = 'pp-rs__line'; p.textContent = line; card.appendChild(p); }
      cardsWrap.appendChild(card);
    }
    content.appendChild(cardsWrap);
    wrap.appendChild(content);
    wrap.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a, button'); if (a && wrap.contains(a)) e.preventDefault(); }, true);

    let anchor = null;
    try { anchor = rule.action.target ? document.querySelector(rule.action.target) : null; } catch (e) { anchor = null; }
    if (anchor) anchor.insertAdjacentElement('afterend', wrap);
    else (document.querySelector('main') || document.body).appendChild(wrap);
    return true;
  }

  // Restore a replaced row to its original markup (un-fire / reset), and remove
  // any injected generic strip.
  function restoreRecStrip(rule) {
    const stash = __rsOriginals.get(rule.id);
    if (stash) {
      let container = null;
      try { container = document.querySelector('[data-pp-recstrip="' + rule.id + '"]') || (stash.selector && document.querySelector(stash.selector)); } catch (e) { container = null; }
      if (container) { container.innerHTML = stash.html; container.removeAttribute('data-pp-recstrip'); }
      __rsOriginals.delete(rule.id);
    }
    const injected = document.getElementById('personalise-recstrip-' + rule.id);
    if (injected) injected.remove();
  }

  function ruleApplies(rule) {
    if (!rule.appliesOn || !rule.appliesOn.length) return true;
    const url = window.location.href;
    const path = window.location.pathname || '/';
    return rule.appliesOn.some(a => patternMatches(a.pattern, a.kind, url, path));
  }
  function evaluateRules() {
    let anyNewlyFired = false;
    for (const rule of config.thresholdRules) {
      const score = state.scores[rule.topicId] || 0;
      if (score < rule.threshold) continue;
      if (!ruleApplies(rule)) continue;
      const fn = actions[rule.action.type];
      if (!fn) { console.warn(`[personalise] unknown action ${rule.action.type}`); continue; }
      const ok = fn(rule);
      if (ok && !state.firedRules.includes(rule.id)) {
        state.firedRules.push(rule.id); saveState();
        anyNewlyFired = true;
      }
      if (ok) console.info(`[personalise] fired rule ${rule.id}`);
    }
    // If we just fired a new rule, refresh pre-apply so subsequent SPA
    // navigations paint the swapped image straight away.
    if (anyNewlyFired && typeof preApplyPaintedRules === 'function') preApplyPaintedRules();
  }

  // -------------------- Panel styles --------------------
  const PANEL_CSS = `
    /* z-index 2147483647 = max signed int; sits above any chatbot/consent widget.
       isolation:isolate prevents a parent creating a new stacking context that traps us. */
    #pp-panel { position: fixed; z-index: 2147483647; isolation: isolate;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #222; background: #fff; border: 1px solid #d8d8d8;
      box-shadow: 0 12px 40px rgba(0,0,0,0.28); border-radius: 8px;
      width: 340px; overflow: hidden;
      /* Default position (overridden by JS once ui.pos is set) */
      bottom: 16px; right: 16px; }
    #pp-panel.is-positioned { bottom: auto; right: auto; }
    #pp-panel.is-sized { /* width + height inline by JS */ }
    #pp-panel__header { display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; background: #4d726d; color: #fff; cursor: grab; user-select: none; touch-action: none;
      flex: 0 0 auto; }
    #pp-panel__header.is-dragging { cursor: grabbing; }
    #pp-panel__header strong { font-weight: 600; letter-spacing: 0.4px; }
    #pp-panel__client { font-size: 10px; opacity: 0.85; }
    #pp-panel__toggle { background: transparent; border: 0; color: #fff; font-size: 16px; cursor: pointer; padding: 0 4px; }
    #pp-panel__body { padding: 12px 14px; max-height: 60vh; overflow-y: auto; }
    /* When a size is set explicitly, panel becomes a flex column so the body
       stretches and its overflow works instead of overflowing the panel. */
    #pp-panel.is-sized { display: flex; flex-direction: column; }
    #pp-panel.is-sized #pp-panel__body { max-height: none; flex: 1 1 auto; overflow-y: auto; }

    /* Resize handles (expanded only). 8 handles: 4 corners + 4 sides. */
    #pp-panel:not(.is-collapsed) .pp-resize { position: absolute; z-index: 1; touch-action: none; }
    #pp-panel.is-collapsed .pp-resize { display: none; }
    #pp-panel .pp-resize-n  { top: -3px; left: 8px; right: 8px; height: 6px; cursor: ns-resize; }
    #pp-panel .pp-resize-s  { bottom: -3px; left: 8px; right: 8px; height: 6px; cursor: ns-resize; }
    #pp-panel .pp-resize-e  { top: 8px; bottom: 8px; right: -3px; width: 6px; cursor: ew-resize; }
    #pp-panel .pp-resize-w  { top: 8px; bottom: 8px; left: -3px; width: 6px; cursor: ew-resize; }
    #pp-panel .pp-resize-ne { top: -3px; right: -3px; width: 12px; height: 12px; cursor: nesw-resize; }
    #pp-panel .pp-resize-nw { top: -3px; left: -3px; width: 12px; height: 12px; cursor: nwse-resize; }
    #pp-panel .pp-resize-se { bottom: -3px; right: -3px; width: 12px; height: 12px; cursor: nwse-resize; }
    #pp-panel .pp-resize-sw { bottom: -3px; left: -3px; width: 12px; height: 12px; cursor: nesw-resize; }
    /* Slight visual hint on the SE corner (the most-used one) */
    #pp-panel:not(.is-collapsed) .pp-resize-se::after { content: ''; position: absolute; right: 3px; bottom: 3px;
      width: 6px; height: 6px; border-right: 2px solid #4d726d; border-bottom: 2px solid #4d726d; opacity: 0.5; }
    body.pp-resizing, body.pp-resizing * { user-select: none !important; }

    /* Expanded header \u2014 flex layout for title / client / minus button. */
    #pp-panel:not(.is-collapsed) .pp-expanded-header { display: flex; align-items: center; justify-content: space-between; width: 100%; }
    #pp-panel:not(.is-collapsed) .pp-badge-content { display: none; }

    /* Collapsed = round Salesforce-blue badge. Header becomes the badge. */
    #pp-panel.is-collapsed { width: 64px; height: 64px; border-radius: 50%; overflow: visible;
      background: transparent; border: 0; box-shadow: none; }
    #pp-panel.is-collapsed #pp-panel__body { display: none; }
    #pp-panel.is-collapsed #pp-panel__header { padding: 0; background: #00A1E0;
      width: 64px; height: 64px; border-radius: 50%; justify-content: center; align-items: center;
      box-shadow: 0 6px 24px rgba(0,161,224,0.5); border: 2px solid #fff; position: relative; }
    #pp-panel.is-collapsed #pp-panel__header:hover { background: #0091cf; }
    #pp-panel.is-collapsed .pp-expanded-header { display: none; }
    #pp-panel.is-collapsed .pp-badge-content { display: block; width: 44px; height: 44px; }
    #pp-panel.is-collapsed .pp-badge-content svg { width: 100%; height: 100%; display: block; }
    /* Avatar mode: full-bleed round image replaces the SVG + coloured disc. */
    #pp-panel.is-collapsed.has-avatar #pp-panel__header { background: transparent; padding: 0;
      border: 2px solid #fff; }
    #pp-panel.is-collapsed.has-avatar .pp-badge-content { width: 60px; height: 60px; border-radius: 50%; overflow: hidden; }
    #pp-panel.is-collapsed.has-avatar .pp-badge-content img { width: 100%; height: 100%; object-fit: cover; display: block; }

    /* Chunky + in the top-right of the collapsed badge to expand */
    #pp-panel.is-collapsed .pp-expand-btn { position: absolute; top: -6px; right: -6px;
      width: 22px; height: 22px; border-radius: 50%; background: #fff; color: #00A1E0;
      border: 2px solid #00A1E0; font: 700 16px/16px -apple-system, sans-serif; cursor: pointer;
      display: flex; align-items: center; justify-content: center; padding: 0;
      box-shadow: 0 2px 6px rgba(0,0,0,0.15); }
    #pp-panel.is-collapsed .pp-expand-btn:hover { background: #00A1E0; color: #fff; }
    #pp-panel:not(.is-collapsed) .pp-expand-btn { display: none; }

    #pp-panel .pp-mode-tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid #eee; }
    #pp-panel .pp-mode-tab { flex: 1; padding: 8px; text-align: center; cursor: pointer; font-size: 11px;
      text-transform: uppercase; letter-spacing: 1px; font-weight: 600; color: #999; background: transparent;
      border: 0; border-bottom: 2px solid transparent; }
    #pp-panel .pp-mode-tab.is-active { color: #4d726d; border-bottom-color: #4d726d; }

    #pp-panel h4 { margin: 12px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #666; font-weight: 600; }
    #pp-panel h4:first-child { margin-top: 0; }
    #pp-panel ul { margin: 0 0 8px; padding: 0; list-style: none; }
    #pp-panel li { padding: 4px 0; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    #pp-panel li:last-child { border-bottom: 0; }
    #pp-panel .pp-score { font-weight: 600; color: #4d726d; }
    #pp-panel .pp-fired { color: #1f6fb0; font-weight: 600; }
    #pp-panel .pp-empty { color: #999; font-style: italic; padding: 4px 0; }
    #pp-panel .pp-hint { color: #888; font-size: 10px; margin: 4px 0 8px; font-style: italic; }

    /* Persona picker row */
    #pp-panel .pp-persona-row { display: flex; gap: 6px; align-items: center; margin: 4px 0 2px; position: relative; }
    #pp-panel .pp-persona-lib { flex: 0 0 34px; height: 34px; padding: 0; background: #f6f6f2;
      border: 1px solid #d8d8d8; border-radius: 4px; cursor: pointer; font: 700 14px/1 -apple-system, sans-serif;
      color: #4d726d; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    #pp-panel .pp-persona-lib:hover { background: #ebeae4; }
    #pp-panel .pp-persona-preview { width: 100%; height: 100%; object-fit: cover; display: block; }
    #pp-panel .pp-persona-input { flex: 1; padding: 8px; font-size: 11px; border: 1px solid #d8d8d8; border-radius: 4px; background: #fff; color: #222; }
    #pp-panel .pp-persona-clear { flex: 0 0 24px; height: 28px; padding: 0; background: transparent; border: 0; color: #b03a2e; font-size: 16px; cursor: pointer; }
    #pp-panel .pp-persona-clear:hover { color: #7a281f; }
    /* Popover of avatar choices */
    #pp-panel .pp-persona-popover { position: absolute; top: 100%; left: 0; margin-top: 6px; background: #fff;
      border: 1px solid #d8d8d8; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.18); padding: 8px;
      z-index: 10; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; min-width: 200px; }
    #pp-panel .pp-persona-choice { display: flex; flex-direction: column; align-items: center; gap: 4px;
      cursor: pointer; padding: 4px 2px 6px; border-radius: 4px; border: 1px solid transparent; }
    #pp-panel .pp-persona-choice:hover { background: #f6f6f2; border-color: #d8d8d8; }
    #pp-panel .pp-persona-choice img { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; }
    #pp-panel .pp-persona-choice span { font-size: 10px; color: #333; }
    #pp-panel .pp-url { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    #pp-panel .pp-current-url { background: #f7f7f7; padding: 6px 8px; border-radius: 4px; margin-bottom: 8px; }
    #pp-panel .pp-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
    #pp-panel .pp-row select, #pp-panel .pp-row input { flex: 1; padding: 6px 8px; font-size: 12px;
      border: 1px solid #d8d8d8; border-radius: 4px; background: #fff; color: #222; }
    #pp-panel .pp-row input.pp-weight { flex: 0 0 60px; }
    #pp-panel .pp-row input.pp-kind { flex: 0 0 80px; }
    #pp-panel button.pp-btn { padding: 6px 10px; font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 1px; cursor: pointer; border: 1px solid #4d726d;
      background: #fff; color: #4d726d; border-radius: 4px; }
    #pp-panel button.pp-btn:hover { background: #4d726d; color: #fff; }
    #pp-panel button.pp-btn--full { width: 100%; margin-top: 6px; }
    #pp-panel button.pp-btn--danger { border-color: #b03a2e; color: #b03a2e; }
    #pp-panel button.pp-btn--danger:hover { background: #b03a2e; color: #fff; }
    #pp-panel button.pp-btn--sm { padding: 3px 6px; font-size: 10px; letter-spacing: 0.5px; }
    #pp-panel button.pp-icon { background: transparent; border: 0; color: #999; cursor: pointer; font-size: 14px; padding: 0 2px; }
    #pp-panel button.pp-icon:hover { color: #b03a2e; }
    #pp-panel .pp-actions-row { display: flex; gap: 6px; margin-top: 8px; }
    #pp-panel .pp-actions-row .pp-btn { flex: 1; }
    #pp-panel .pp-topic-edit { flex: 1; padding: 4px 6px; font-size: 12px; border: 1px solid transparent; background: transparent; }
    #pp-panel .pp-topic-edit:focus { outline: none; border-color: #4d726d; background: #fff; }
    #pp-panel .pp-rule-body { flex: 1; min-width: 0; }
    #pp-panel .pp-rule-body input { width: 100%; padding: 3px 5px; font-size: 11px; border: 1px solid #eee; border-radius: 3px; }
    #pp-panel .pp-rule-meta { font-size: 10px; color: #888; margin-top: 2px; }
    #pp-panel details { margin-top: 8px; }
    #pp-panel details summary { cursor: pointer; font-size: 11px; color: #666; padding: 4px 0; }
    #pp-panel textarea.pp-json { width: 100%; height: 120px; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      border: 1px solid #d8d8d8; border-radius: 4px; padding: 6px; box-sizing: border-box; margin-top: 4px; }
    #pp-panel textarea.pp-code { width: 100%; height: 90px; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      border: 1px solid #d8d8d8; border-radius: 4px; padding: 6px; box-sizing: border-box; margin-top: 4px; }

    #pp-panel .pp-thr-rule { display: block; padding: 8px; border: 1px solid #e5e5e5; border-radius: 6px; margin-bottom: 8px; background: #fafafa; }
    #pp-panel .pp-thr-rule + .pp-thr-rule { margin-top: 8px; }
    #pp-panel .pp-thr-rule .pp-thr-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; margin-bottom: 6px; }
    #pp-panel .pp-thr-rule .pp-thr-header input { flex: 1; padding: 4px 6px; font-size: 12px; font-weight: 600; border: 1px solid transparent; background: transparent; }
    #pp-panel .pp-thr-rule .pp-thr-header input:focus { border-color: #4d726d; background: #fff; outline: none; }
    /* Collapse chevron */
    #pp-panel .pp-thr-rule .pp-thr-chevron { flex: 0 0 20px; padding: 2px 0 0; background: transparent; border: 0; color: #666; cursor: pointer; font-size: 12px; }
    #pp-panel .pp-thr-rule .pp-thr-chevron:hover { color: #4d726d; }
    /* Multi-line description */
    #pp-panel .pp-thr-rule .pp-thr-desc { flex: 1; padding: 4px 6px; font: 600 12px/1.35 -apple-system, sans-serif;
      border: 1px solid transparent; background: transparent; resize: none; overflow: hidden; box-sizing: border-box;
      min-height: 22px; max-height: 62px; }
    #pp-panel .pp-thr-rule .pp-thr-desc:focus { border-color: #4d726d; background: #fff; outline: none; }
    /* Collapsed rule hides the body */
    #pp-panel .pp-thr-rule.is-collapsed .pp-thr-body { display: none; }
    #pp-panel .pp-thr-rule.is-collapsed { padding-bottom: 6px; }
    #pp-panel .pp-thr-field { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    #pp-panel .pp-thr-field label { flex: 0 0 68px; font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    #pp-panel .pp-thr-field input, #pp-panel .pp-thr-field select { flex: 1; padding: 4px 6px; font-size: 11px; border: 1px solid #d8d8d8; border-radius: 3px; background: #fff; }
    #pp-panel .pp-thr-field input[type=number] { flex: 0 0 60px; }
    #pp-panel .pp-thr-actions { display: flex; gap: 6px; margin-top: 6px; }
    #pp-panel .pp-thr-actions .pp-btn { flex: 1; }

    /* Pick-element overlay \u2014 a fixed div on top of the current hovered element */
    #pp-pick-overlay { position: fixed; pointer-events: none; z-index: 2147483645;
      border: 2px solid #ff6b3d; background: rgba(255,107,61,0.12); transition: all 60ms linear; }
    #pp-pick-hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483646;
      background: #222; color: #fff; padding: 10px 16px; border-radius: 6px;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
    #pp-pick-hint kbd { background: #444; padding: 2px 6px; border-radius: 3px; font-family: inherit; margin: 0 2px; }
    body.pp-picking, body.pp-picking * { cursor: crosshair !important; }

    #personalise-popup .pp-popup__backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 2147483643; }
    #personalise-popup .pp-popup__box { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
      z-index: 2147483644; background: #fff; padding: 32px; max-width: 420px; border-radius: 8px;
      font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
    #personalise-popup .pp-popup__box h3 { margin: 0 0 12px; font: italic 1.4rem "Merriweather", Georgia, serif; }
    #personalise-popup .pp-popup__close { position: absolute; top: 8px; right: 12px; background: transparent;
      border: 0; font-size: 24px; cursor: pointer; color: #666; }
    #personalise-popup .pp-popup__cta { display: inline-block; margin-top: 16px; padding: 12px 28px;
      background: #4d726d; color: #fff; text-decoration: none; font-size: 0.8rem; font-weight: 600;
      letter-spacing: 1.5px; text-transform: uppercase; }

    /* AI-designed popup shell. We own backdrop/box/close; model HTML+CSS lives
       inside .pp-rp__content (its CSS is scoped to .pp-rp__box by scopeCss). */
    #personalise-richpopup .pp-rp__backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 2147483643; }
    #personalise-richpopup .pp-rp__box { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
      z-index: 2147483644; background: #fff; width: min(460px, 92vw); max-height: 88vh; overflow: auto;
      border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,0.4); padding: 28px; box-sizing: border-box;
      font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #222; }
    #personalise-richpopup .pp-rp__close { position: absolute; top: 8px; right: 12px; background: transparent;
      border: 0; font-size: 24px; cursor: pointer; color: #666; line-height: 1; z-index: 1; }
    #personalise-richpopup .pp-rp__close:hover { color: #222; }
    #personalise-richpopup .pp-rp__thanks { padding: 24px 8px; text-align: center; font-size: 16px; color: #2e7d32; }

    /* Recommendations strip — minimal baseline so an undesigned strip still
       reads as a row of cards; model CSS (scoped) layers on top. */
    [id^="personalise-recstrip-"] { margin: 24px 0; box-sizing: border-box; }
    [id^="personalise-recstrip-"] .pp-rs__content { max-width: 1200px; margin: 0 auto; padding: 0 16px;
      font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #222; }
    [id^="personalise-recstrip-"] .cards, [id^="personalise-recstrip-"] .pp-rs__cards {
      display: flex; gap: 16px; flex-wrap: wrap; }
    [id^="personalise-recstrip-"] img { max-width: 100%; height: auto; display: block; }
    [id^="personalise-recstrip-"] .pp-rs__card { flex: 1 1 160px; max-width: 240px; }
    [id^="personalise-recstrip-"] .pp-rs__line { margin-top: 4px; }

    /* Per-card editor block in the panel */
    #pp-panel .pp-rs-cardedit { border: 1px solid #eee; border-radius: 6px; padding: 6px; margin-bottom: 6px; background: #fff; }

    /* Trainer toggle + pulse overlays */
    #pp-panel .pp-trainer-row { display: flex; align-items: center; justify-content: space-between;
      gap: 8px; padding: 8px 10px; background: #f7f7f2; border: 1px solid #eee; border-radius: 6px; margin-bottom: 12px; }
    #pp-panel .pp-trainer-row label { font-weight: 600; font-size: 11px; color: #444;
      text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; user-select: none; }
    #pp-panel .pp-trainer-row .pp-trainer-hint { display: block; color: #888; font-size: 10px;
      font-weight: 400; text-transform: none; letter-spacing: 0; margin-top: 2px; }
    /* Simple pill toggle */
    #pp-panel .pp-switch { position: relative; display: inline-block; width: 40px; height: 22px; flex: 0 0 40px; }
    #pp-panel .pp-switch input { opacity: 0; width: 0; height: 0; }
    #pp-panel .pp-switch .pp-slider { position: absolute; inset: 0; background: #ccc; border-radius: 22px; transition: 0.2s; cursor: pointer; }
    #pp-panel .pp-switch .pp-slider::before { content: ''; position: absolute; height: 16px; width: 16px;
      left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
    #pp-panel .pp-switch input:checked + .pp-slider { background: #4d726d; }
    #pp-panel .pp-switch input:checked + .pp-slider::before { transform: translateX(18px); }

    /* Legend of topic colors when trainer is on */
    #pp-panel .pp-trainer-legend { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; padding: 0; list-style: none; }
    #pp-panel .pp-trainer-legend li { display: flex; align-items: center; gap: 4px; padding: 3px 8px 3px 5px;
      border-radius: 3px; font-size: 10px; color: #333; background: #f7f7f2; border: 1px solid #eee; }
    #pp-panel .pp-trainer-legend .pp-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }

    /* Pulse outlines are added directly to matching <a> elements */
    @keyframes pp-pulse {
      0%, 100% { box-shadow: 0 0 0 2px var(--pp-pulse-color), 0 0 0 4px rgba(255,255,255,0.6), 0 0 12px 2px var(--pp-pulse-color); }
      50%      { box-shadow: 0 0 0 3px var(--pp-pulse-color), 0 0 0 6px rgba(255,255,255,0.75), 0 0 20px 6px var(--pp-pulse-color); }
    }
    a[data-pp-trainer] { position: relative; border-radius: 3px; animation: pp-pulse 1.6s ease-in-out infinite;
      outline: none !important; transition: none; }
    a[data-pp-trainer]::after { content: attr(data-pp-trainer); position: absolute; top: -8px; right: -8px;
      background: var(--pp-pulse-color); color: #fff; font: 700 10px/1.4 -apple-system, sans-serif;
      padding: 1px 6px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.3); pointer-events: none;
      z-index: 2147483640; white-space: nowrap; }

    /* AI-author modal */
    #pp-ai-modal .pp-ai-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 2147483643; }
    #pp-ai-modal .pp-ai-box { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
      z-index: 2147483644; background: #fff; padding: 24px 28px; width: min(680px, 92vw); max-height: 88vh;
      overflow-y: auto; border-radius: 10px;
      font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #222;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
    #pp-ai-modal h3 { margin: 0 0 4px; font: 600 20px/1.3 Georgia, "Merriweather", serif; }
    #pp-ai-modal .pp-ai-sub { color: #666; margin-bottom: 16px; font-size: 12px; }
    #pp-ai-modal .pp-ai-label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #555; }
    #pp-ai-modal .pp-ai-label--gap { margin-top: 20px; }
    #pp-ai-modal textarea { width: 100%; padding: 10px 12px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      border: 1px solid #d0d0d0; border-radius: 6px; resize: vertical; background: #fafafa; color: #222; box-sizing: border-box; }
    #pp-ai-modal textarea:focus { outline: 0; border-color: #4d726d; background: #fff; }
    #pp-ai-modal .pp-ai-row { display: flex; gap: 8px; margin-top: 8px; }
    #pp-ai-modal .pp-btn { padding: 8px 16px; font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.6px; cursor: pointer; border: 1px solid #4d726d;
      background: #fff; color: #4d726d; border-radius: 4px; }
    #pp-ai-modal .pp-btn:hover { background: #4d726d; color: #fff; }
    #pp-ai-modal .pp-ai-close { position: absolute; top: 10px; right: 14px; background: transparent;
      border: 0; font-size: 26px; cursor: pointer; color: #888; line-height: 1; }
    #pp-ai-modal .pp-ai-close:hover { color: #222; }

    /* Visual image gallery picker */
    #pp-image-gallery .pp-ig-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 2147483643; }
    #pp-image-gallery .pp-ig-box { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
      z-index: 2147483644; background: #fff; width: min(760px, 94vw); max-height: 86vh; overflow: hidden;
      border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,0.4); display: flex; flex-direction: column;
      font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #222; }
    #pp-image-gallery .pp-ig-head { display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-bottom: 1px solid #eee; flex: 0 0 auto; }
    #pp-image-gallery .pp-ig-head h3 { margin: 0; font: 600 18px/1.3 Georgia, "Merriweather", serif; }
    #pp-image-gallery .pp-ig-close { background: transparent; border: 0; font-size: 26px; cursor: pointer; color: #888; line-height: 1; }
    #pp-image-gallery .pp-ig-close:hover { color: #222; }
    #pp-image-gallery .pp-ig-empty { padding: 40px 20px; text-align: center; color: #888; }
    #pp-image-gallery .pp-ig-grid { padding: 16px 20px; overflow-y: auto;
      display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
    #pp-image-gallery .pp-ig-cell { position: relative; padding: 0; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;
      cursor: pointer; background: #fafafa; text-align: left; }
    #pp-image-gallery .pp-ig-vbadge { position: absolute; top: 6px; left: 6px; width: 22px; height: 22px;
      border-radius: 50%; background: rgba(0,0,0,0.6); color: #fff; font-size: 10px; line-height: 22px;
      text-align: center; pointer-events: none; }
    #pp-image-gallery .pp-ig-cell:hover { border-color: #ff6b3d; box-shadow: 0 4px 14px rgba(255,107,61,0.25); }
    #pp-image-gallery .pp-ig-thumb { width: 100%; height: 92px; background-size: cover; background-position: center;
      background-repeat: no-repeat; background-color: #eee; }
    #pp-image-gallery .pp-ig-meta { padding: 6px 8px; font-size: 11px; color: #555;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;

  // -------------------- DOM helpers --------------------
  function el(tag, opts) {
    const node = document.createElement(tag);
    if (!opts) return node;
    if (opts.className) node.className = opts.className;
    if (opts.id) node.id = opts.id;
    if (opts.text != null) node.textContent = opts.text;
    if (opts.type) node.type = opts.type;
    if (opts.value != null) node.value = opts.value;
    if (opts.placeholder) node.placeholder = opts.placeholder;
    if (opts.title) node.title = opts.title;
    if (opts.ariaLabel) node.setAttribute('aria-label', opts.ariaLabel);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function shortId(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 8);
  }

  // -------------------- CSS selector for a clicked element --------------------
  // Walks up the tree building the shortest selector that uniquely resolves to
  // this element. Prefers id, then unique class combos, then :nth-of-type.
  function uniqueSelector(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let seg = node.tagName.toLowerCase();
      const cls = (node.getAttribute('class') || '').trim().split(/\s+/)
        .filter(c => c && !c.startsWith('pp-') && !c.startsWith('personalise'));
      if (cls.length) seg += '.' + cls.map(c => CSS.escape(c)).join('.');
      // Disambiguate with nth-of-type if the segment alone matches multiple siblings
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          seg += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(seg);
      // Try short-circuit: if the joined selector is already unique, stop.
      const candidate = parts.join(' > ');
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (e) { /* keep walking */ }
      node = parent;
    }
    return parts.join(' > ');
  }

  // -------------------- Click-to-pick element mode --------------------
  let pickState = null;
  function startPick(onPicked) {
    if (pickState) return;
    const overlay = document.createElement('div'); overlay.id = 'pp-pick-overlay';
    const hint = document.createElement('div'); hint.id = 'pp-pick-hint';
    hint.innerHTML = 'Click any element to capture its selector \u2014 press <kbd>Esc</kbd> to cancel';
    document.body.appendChild(overlay);
    document.body.appendChild(hint);
    document.body.classList.add('pp-picking');

    function isPanelEl(t) { return t && (t.closest && (t.closest('#pp-panel') || t.closest('#pp-pick-overlay') || t.closest('#pp-pick-hint'))); }
    function move(e) {
      const t = document.elementFromPoint(e.clientX, e.clientY);
      if (!t || isPanelEl(t)) { overlay.style.display = 'none'; return; }
      const r = t.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = r.left + 'px'; overlay.style.top = r.top + 'px';
      overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
    }
    function click(e) {
      const t = document.elementFromPoint(e.clientX, e.clientY);
      if (!t || isPanelEl(t)) return;
      e.preventDefault(); e.stopPropagation();
      const sel = uniqueSelector(t);
      cleanup();
      onPicked(sel, t);
    }
    function key(e) { if (e.key === 'Escape') { cleanup(); } }
    function cleanup() {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      overlay.remove(); hint.remove();
      document.body.classList.remove('pp-picking');
      pickState = null;
    }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    pickState = { cleanup };
  }

  // -------------------- Visual image gallery picker --------------------
  // Shows every image on the page as a grid of thumbnails (hero first). The SE
  // clicks one; we hand back its unique selector — same contract as startPick,
  // so everything downstream (pre-apply, SPA re-fire) is unchanged.
  function startImageGallery(onPicked) {
    const existing = document.getElementById('pp-image-gallery');
    if (existing) existing.remove();
    const images = collectPageImages();

    const wrap = document.createElement('div'); wrap.id = 'pp-image-gallery';
    const backdrop = document.createElement('div'); backdrop.className = 'pp-ig-backdrop';
    const box = document.createElement('div'); box.className = 'pp-ig-box';
    const close = () => wrap.remove();

    const head = document.createElement('div'); head.className = 'pp-ig-head';
    const h = document.createElement('h3'); h.textContent = 'Pick the image to replace';
    const closeBtn = document.createElement('button'); closeBtn.className = 'pp-ig-close';
    closeBtn.textContent = '×'; closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', close);
    head.appendChild(h); head.appendChild(closeBtn);
    box.appendChild(head);

    if (!images.length) {
      const empty = document.createElement('div'); empty.className = 'pp-ig-empty';
      empty.textContent = 'No images found on this page.';
      box.appendChild(empty);
    } else {
      const grid = document.createElement('div'); grid.className = 'pp-ig-grid';
      images.forEach((im, i) => {
        const cell = document.createElement('button'); cell.className = 'pp-ig-cell'; cell.type = 'button';
        const thumb = document.createElement('div'); thumb.className = 'pp-ig-thumb';
        thumb.style.backgroundImage = `url('${im.src.replace(/'/g, "\\'")}')`;
        const meta = document.createElement('div'); meta.className = 'pp-ig-meta';
        const kindTag = im.kind === 'bg' ? ' · bg' : (im.kind === 'video' ? ' · video' : '');
        meta.textContent = `${im.w}×${im.h}${kindTag}` + (i === 0 ? ' · largest' : '');
        cell.appendChild(thumb); cell.appendChild(meta);
        cell.title = im.kind === 'video' ? (im.src + '  — video; replace it with a video (.mp4)') : im.src;
        if (im.kind === 'video') { const badge = document.createElement('span'); badge.className = 'pp-ig-vbadge'; badge.textContent = '▶'; cell.appendChild(badge); }
        // Hover highlights the real element on the page so the SE can confirm.
        cell.addEventListener('mouseenter', () => flashElement(im.el, true));
        cell.addEventListener('mouseleave', () => flashElement(im.el, false));
        cell.addEventListener('click', (e) => {
          e.stopPropagation();
          const sel = uniqueSelector(im.el);
          flashElement(im.el, false);
          close();
          onPicked(sel, im.el);
        });
        grid.appendChild(cell);
      });
      box.appendChild(grid);
    }

    wrap.appendChild(backdrop); wrap.appendChild(box);
    document.body.appendChild(wrap);
    backdrop.addEventListener('click', close);
    const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc, true); } };
    document.addEventListener('keydown', esc, true);
  }

  // Briefly outline a page element (used on gallery hover).
  let __flashEl = null;
  function flashElement(el, on) {
    if (__flashEl && __flashEl !== el) { __flashEl.style.outline = __flashEl.__ppPrevOutline || ''; __flashEl = null; }
    if (!(el instanceof Element)) return;
    if (on) {
      el.__ppPrevOutline = el.style.outline;
      el.style.outline = '3px solid #ff6b3d';
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      __flashEl = el;
    } else {
      el.style.outline = el.__ppPrevOutline || '';
      __flashEl = null;
    }
  }

  // -------------------- Panel rendering --------------------
  // Inline Salesforce cloud \u2014 schematic form made of overlapping white circles
  // on the blue badge background. Independent of any external asset; works
  // behind any CSP.
  const SF_CLOUD_SVG =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-label="Salesforce">'
    + '<g fill="#ffffff">'
    +   '<circle cx="34" cy="58" r="22"/>'
    +   '<circle cx="55" cy="45" r="26"/>'
    +   '<circle cx="72" cy="60" r="20"/>'
    +   '<ellipse cx="52" cy="72" rx="30" ry="12"/>'
    + '</g>'
    + '</svg>';

  function applyPositionToPanel(panel) {
    if (ui.pos && typeof ui.pos.left === 'number' && typeof ui.pos.top === 'number') {
      const w = panel.offsetWidth || (ui.collapsed ? 56 : 340);
      const h = panel.offsetHeight || 400;
      // Clamp to viewport so a resize doesn't strand it off-screen
      const maxLeft = Math.max(0, window.innerWidth - w);
      const maxTop = Math.max(0, window.innerHeight - h);
      panel.style.left = Math.min(Math.max(0, ui.pos.left), maxLeft) + 'px';
      panel.style.top = Math.min(Math.max(0, ui.pos.top), maxTop) + 'px';
      panel.classList.add('is-positioned');
    }
  }

  const PP_MIN_W = 300, PP_MIN_H = 240;

  function applySizeToPanel(panel) {
    if (ui.collapsed) {
      // Never apply saved size to the collapsed badge
      panel.classList.remove('is-sized');
      panel.style.width = ''; panel.style.height = '';
      return;
    }
    if (ui.size && typeof ui.size.w === 'number' && typeof ui.size.h === 'number') {
      const w = Math.min(Math.max(PP_MIN_W, ui.size.w), window.innerWidth);
      const h = Math.min(Math.max(PP_MIN_H, ui.size.h), window.innerHeight);
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
      panel.classList.add('is-sized');
    } else {
      panel.classList.remove('is-sized');
      panel.style.width = ''; panel.style.height = '';
    }
  }

  // Attach resize behavior to the 8 handles. dir is a combination of
  // n/s/e/w that describes which edges are being pushed.
  function attachResize(panel, handleEl, dir) {
    let start = null;
    function onDown(e) {
      const pt = e.touches ? e.touches[0] : e;
      const rect = panel.getBoundingClientRect();
      start = {
        x: pt.clientX, y: pt.clientY,
        left: rect.left, top: rect.top,
        w: rect.width, h: rect.height
      };
      document.body.classList.add('pp-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
      e.preventDefault(); e.stopPropagation();
    }
    function onMove(e) {
      if (!start) return;
      const pt = e.touches ? e.touches[0] : e;
      let dx = pt.clientX - start.x;
      let dy = pt.clientY - start.y;
      let left = start.left, top = start.top, w = start.w, h = start.h;
      if (dir.includes('e')) w = start.w + dx;
      if (dir.includes('s')) h = start.h + dy;
      if (dir.includes('w')) { w = start.w - dx; left = start.left + dx; }
      if (dir.includes('n')) { h = start.h - dy; top = start.top + dy; }
      // Clamp to mins; recompute left/top so the opposite edge stays put
      if (w < PP_MIN_W) {
        if (dir.includes('w')) left -= (PP_MIN_W - w);
        w = PP_MIN_W;
      }
      if (h < PP_MIN_H) {
        if (dir.includes('n')) top -= (PP_MIN_H - h);
        h = PP_MIN_H;
      }
      // Clamp to viewport
      if (left < 0) { w += left; left = 0; }
      if (top < 0) { h += top; top = 0; }
      if (left + w > window.innerWidth) w = window.innerWidth - left;
      if (top + h > window.innerHeight) h = window.innerHeight - top;
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
      panel.classList.add('is-positioned');
      panel.classList.add('is-sized');
      if (e.cancelable) e.preventDefault();
    }
    function onUp() {
      if (!start) return;
      document.body.classList.remove('pp-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      // Persist final size and position
      ui.size = { w: parseFloat(panel.style.width) || 0, h: parseFloat(panel.style.height) || 0 };
      ui.pos = { left: parseFloat(panel.style.left) || 0, top: parseFloat(panel.style.top) || 0 };
      saveUi();
      start = null;
    }
    handleEl.addEventListener('mousedown', onDown);
    handleEl.addEventListener('touchstart', onDown, { passive: false });
  }

  function attachDrag(panel, header) {
    let start = null;
    function onDown(e) {
      // Ignore drags on interactive children (buttons, links)
      if (e.target.closest && e.target.closest('button, input, a, select, textarea')) return;
      const rect = panel.getBoundingClientRect();
      const pt = e.touches ? e.touches[0] : e;
      start = { dx: pt.clientX - rect.left, dy: pt.clientY - rect.top, moved: false };
      header.classList.add('is-dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
      e.preventDefault();
    }
    function onMove(e) {
      if (!start) return;
      const pt = e.touches ? e.touches[0] : e;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      let left = pt.clientX - start.dx;
      let top = pt.clientY - start.dy;
      left = Math.min(Math.max(0, left), window.innerWidth - w);
      top = Math.min(Math.max(0, top), window.innerHeight - h);
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.classList.add('is-positioned');
      // Track movement so a small jitter click doesn't get treated as a click
      if (Math.abs(pt.clientX - (start.dx + panel.offsetLeft)) > 3 ||
          Math.abs(pt.clientY - (start.dy + panel.offsetTop)) > 3) {
        start.moved = true;
      }
      if (e.cancelable) e.preventDefault();
    }
    function onUp() {
      if (!start) return;
      header.classList.remove('is-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      // Persist position
      ui.pos = { left: parseFloat(panel.style.left) || 0, top: parseFloat(panel.style.top) || 0 };
      saveUi();
      // If the user actually moved, suppress the click that follows on the same event chain
      const wasMove = start.moved;
      start = null;
      if (wasMove) {
        // Absorb the immediately-following click
        const abs = (ev) => { ev.stopPropagation(); ev.preventDefault(); document.removeEventListener('click', abs, true); };
        document.addEventListener('click', abs, true);
        setTimeout(() => document.removeEventListener('click', abs, true), 50);
      }
    }
    header.addEventListener('mousedown', onDown);
    header.addEventListener('touchstart', onDown, { passive: false });
  }

  function renderPanel() {
    let panel = document.getElementById('pp-panel');
    if (!panel) {
      const style = el('style', { id: 'pp-panel__style' });
      style.textContent = PANEL_CSS;
      document.head.appendChild(style);
      panel = el('div', { id: 'pp-panel' });
      document.body.appendChild(panel);
    }
    if (ui.collapsed) panel.classList.add('is-collapsed');
    else panel.classList.remove('is-collapsed');
    if (ui.collapsed && config.avatarUrl) panel.classList.add('has-avatar');
    else panel.classList.remove('has-avatar');

    // Preserve the body's scroll position across the full rebuild so adding a
    // card, "Design with gateway", etc. don't jump the SE back to the top.
    const prevBody = document.getElementById('pp-panel__body');
    const prevScroll = prevBody ? prevBody.scrollTop : 0;

    clear(panel);

    // Header \u2014 same element for both expanded and collapsed; content swaps via CSS
    const header = el('div', { id: 'pp-panel__header' });
    header.title = ui.collapsed ? 'Drag to move \u00B7 click + to expand' : 'Drag to move';

    // Collapsed content: Salesforce cloud badge OR persona avatar + expand (+) button
    const badge = el('div', { className: 'pp-badge-content' });
    if (config.avatarUrl) {
      const img = document.createElement('img');
      img.src = config.avatarUrl;
      img.alt = 'Persona avatar';
      img.onerror = () => { badge.innerHTML = SF_CLOUD_SVG; panel.classList.remove('has-avatar'); };
      badge.appendChild(img);
    } else {
      badge.innerHTML = SF_CLOUD_SVG;
    }
    header.appendChild(badge);
    const expandBtn = el('button', { className: 'pp-expand-btn', ariaLabel: 'Expand', text: '+' });
    header.appendChild(expandBtn);

    // Expanded content: title + client + collapse (\u2212) button
    const expandedHeader = el('div', { className: 'pp-expanded-header' });
    const headerLeft = el('div');
    headerLeft.appendChild(el('strong', { text: 'Personalise' }));
    headerLeft.appendChild(el('div', { id: 'pp-panel__client', text: config.client }));
    const toggleBtn = el('button', { id: 'pp-panel__toggle', ariaLabel: 'Minimise', text: '\u2212' });
    expandedHeader.appendChild(headerLeft);
    expandedHeader.appendChild(toggleBtn);
    header.appendChild(expandedHeader);
    panel.appendChild(header);

    const body = el('div', { id: 'pp-panel__body' });

    // Mode tabs
    const tabs = el('div', { className: 'pp-mode-tabs' });
    const runtimeTab = el('button', { className: 'pp-mode-tab' + (ui.mode === 'runtime' ? ' is-active' : ''), text: 'Runtime' });
    const configTab = el('button', { className: 'pp-mode-tab' + (ui.mode === 'config' ? ' is-active' : ''), text: 'Config' });
    tabs.appendChild(runtimeTab);
    tabs.appendChild(configTab);
    body.appendChild(tabs);

    if (ui.mode === 'runtime') renderRuntime(body);
    else renderConfig(body);

    panel.appendChild(body);

    // Resize handles (expanded only). Added after body so they layer on top.
    if (!ui.collapsed) {
      const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
      for (const d of dirs) {
        const h = document.createElement('div');
        h.className = 'pp-resize pp-resize-' + d;
        panel.appendChild(h);
        attachResize(panel, h, d);
      }
    }

    // Apply saved size + position after body is in DOM so offsetWidth/Height are correct
    applySizeToPanel(panel);
    applyPositionToPanel(panel);

    // Restore the previous scroll position (clamped to the new content height).
    if (prevScroll && !ui.collapsed) body.scrollTop = prevScroll;

    // Wiring \u2014 drag first so it can suppress the trailing click on move.
    // Header itself no longer toggles collapse; only the \u2212 / + buttons do,
    // so users can grab-and-drag the header without accidentally minimising.
    attachDrag(panel, header);
    toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); ui.collapsed = true; saveUi(); renderPanel(); });
    expandBtn.addEventListener('click', (e) => { e.stopPropagation(); ui.collapsed = false; saveUi(); renderPanel(); });
    runtimeTab.addEventListener('click', (e) => { e.stopPropagation(); ui.mode = 'runtime'; saveUi(); renderPanel(); });
    configTab.addEventListener('click', (e) => { e.stopPropagation(); ui.mode = 'config'; saveUi(); renderPanel(); });
  }

  // -------------------- Runtime view --------------------
  // -------------------- Trainer mode --------------------
  // When enabled, every <a href> whose URL would match a urlRule gets a
  // pulsing outline colored by the topic it contributes to. Helps rehearse
  // click paths before a customer demo.
  let __trainerObserver = null;
  let __trainerDebounce = null;

  // Deterministic HSL color per topic id -- same id always maps to same color.
  function topicColor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    const hue = Math.abs(h) % 360;
    return `hsl(${hue}, 70%, 45%)`;
  }

  // Turn an anchor's href into (url, path) tuple compatible with patternMatches.
  function anchorTarget(a) {
    try {
      const u = new URL(a.getAttribute('href'), window.location.href);
      // Only consider same-origin links; cross-origin links won't score under
      // the normal engine flow either.
      if (u.origin !== window.location.origin) return null;
      return { url: u.href, path: u.pathname + u.search };
    } catch (e) { return null; }
  }

  // Which topics would this anchor contribute to, and what's the summed weight?
  function anchorContribution(a) {
    const target = anchorTarget(a);
    if (!target) return null;
    const byTopic = new Map();
    for (const rule of config.urlRules) {
      if (patternMatches(rule.pattern, rule.kind, target.url, target.path)) {
        byTopic.set(rule.topicId, (byTopic.get(rule.topicId) || 0) + (rule.weight || 1));
      }
    }
    if (!byTopic.size) return null;
    return byTopic;
  }

  function applyTrainerToAnchor(a) {
    const contrib = anchorContribution(a);
    if (!contrib) {
      if (a.hasAttribute('data-pp-trainer')) removeTrainerFromAnchor(a);
      return;
    }
    // Build label like "+1 Sri Lanka" or "+3 (2 topics)" for multi-topic anchors
    let label;
    let color;
    if (contrib.size === 1) {
      const [topicId, weight] = contrib.entries().next().value;
      const topic = config.topics.find(t => t.id === topicId);
      label = `+${weight} ${topic ? topic.label : topicId}`;
      color = topicColor(topicId);
    } else {
      const total = [...contrib.values()].reduce((s, w) => s + w, 0);
      label = `+${total} (${contrib.size} topics)`;
      // Mix: use the first topic's color as the base
      color = topicColor(contrib.keys().next().value);
    }
    a.setAttribute('data-pp-trainer', label);
    a.style.setProperty('--pp-pulse-color', color);
  }

  function removeTrainerFromAnchor(a) {
    a.removeAttribute('data-pp-trainer');
    a.style.removeProperty('--pp-pulse-color');
  }

  function scanTrainer() {
    if (!ui.trainer) return;
    // Only apply to anchors that have an href. Skip anchors inside our own panel.
    const anchors = document.querySelectorAll('a[href]');
    for (const a of anchors) {
      if (a.closest && a.closest('#pp-panel')) continue;
      applyTrainerToAnchor(a);
    }
  }

  function scheduleTrainerScan() {
    if (__trainerDebounce) clearTimeout(__trainerDebounce);
    __trainerDebounce = setTimeout(scanTrainer, 120);
  }

  function enableTrainer() {
    scanTrainer();
    if (__trainerObserver) return;
    __trainerObserver = new MutationObserver(scheduleTrainerScan);
    __trainerObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    // Also re-scan on SPA navigation (custom event dispatched by our own hook)
    window.addEventListener('personalise:navigate', scheduleTrainerScan);
  }

  function disableTrainer() {
    if (__trainerObserver) { __trainerObserver.disconnect(); __trainerObserver = null; }
    window.removeEventListener('personalise:navigate', scheduleTrainerScan);
    // Strip all applied outlines
    document.querySelectorAll('a[data-pp-trainer]').forEach(removeTrainerFromAnchor);
  }

  function refreshTrainer() {
    if (ui.trainer) enableTrainer();
    else disableTrainer();
  }

  function renderRuntime(body) {
    // Trainer toggle -- sits at the very top of Runtime so it's immediate.
    const trainerRow = el('div', { className: 'pp-trainer-row' });
    const label = document.createElement('label');
    label.htmlFor = 'pp-trainer-toggle';
    label.appendChild(document.createTextNode('Trainer mode'));
    const hint = el('span', { className: 'pp-trainer-hint', text: 'Highlight scoring links on the page' });
    label.appendChild(hint);
    // Wrap the switch in a <label> so clicking the pill toggles the checkbox
    // even though the checkbox itself is visually hidden.
    const sw = document.createElement('label');
    sw.className = 'pp-switch';
    sw.htmlFor = 'pp-trainer-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox'; input.id = 'pp-trainer-toggle'; input.checked = !!ui.trainer;
    const slider = document.createElement('span'); slider.className = 'pp-slider';
    sw.appendChild(input);
    sw.appendChild(slider);
    trainerRow.appendChild(label);
    trainerRow.appendChild(sw);
    body.appendChild(trainerRow);

    // Legend (only when trainer is on and there are topics with URL rules)
    if (ui.trainer && config.topics.length) {
      const topicIdsInUse = new Set(config.urlRules.map(r => r.topicId));
      const legendTopics = config.topics.filter(t => topicIdsInUse.has(t.id));
      if (legendTopics.length) {
        const legend = el('ul', { className: 'pp-trainer-legend' });
        for (const t of legendTopics) {
          const li = el('li');
          const sw2 = el('span', { className: 'pp-swatch' });
          sw2.style.background = topicColor(t.id);
          li.appendChild(sw2);
          li.appendChild(document.createTextNode(t.label));
          legend.appendChild(li);
        }
        body.appendChild(legend);
      }
    }

    input.addEventListener('change', () => {
      ui.trainer = input.checked;
      saveUi();
      refreshTrainer();
      renderPanel();
    });

    body.appendChild(el('h4', { text: 'Tag scores' }));
    const tagList = el('ul');
    if (!config.topics.length) tagList.appendChild(el('li', { className: 'pp-empty', text: 'No topics yet' }));
    else {
      for (const t of config.topics) {
        const li = el('li');
        li.appendChild(el('span', { text: t.label }));
        li.appendChild(el('span', { className: 'pp-score', text: String(state.scores[t.id] || 0) }));
        tagList.appendChild(li);
      }
    }
    body.appendChild(tagList);

    body.appendChild(el('h4', { text: 'Threshold rules' }));
    const ruleList = el('ul');
    if (!config.thresholdRules.length) ruleList.appendChild(el('li', { className: 'pp-empty', text: 'No threshold rules configured' }));
    else {
      for (const r of config.thresholdRules) {
        const li = el('li');
        const score = state.scores[r.topicId] || 0;
        const fired = state.firedRules.includes(r.id);
        li.appendChild(el('span', { text: r.description || r.id }));
        li.appendChild(el('span', { className: fired ? 'pp-fired' : '', text: fired ? 'FIRED' : `${score} / ${r.threshold}` }));
        ruleList.appendChild(li);
      }
    }
    body.appendChild(ruleList);

    const actionsRow = el('div', { className: 'pp-actions-row' });
    const runBtn = el('button', { className: 'pp-btn', text: 'Re-evaluate' });
    const resetBtn = el('button', { className: 'pp-btn pp-btn--danger', text: 'Reset scores' });
    actionsRow.appendChild(runBtn);
    actionsRow.appendChild(resetBtn);
    body.appendChild(actionsRow);

    runBtn.addEventListener('click', (e) => { e.stopPropagation(); evaluateRules(); renderPanel(); });
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state = { scores: {}, firedRules: [], scoredUrls: [] };
      saveState();
      window.location.reload();
    });
  }

  // -------------------- Threshold-rule editor --------------------
  function renderThresholdRule(rule) {
    let wrap = el('div', { className: 'pp-thr-rule' });
    // Collapsed state stored on the rule itself so it survives reloads/imports.
    // Default: expanded (undefined -> expanded).
    const collapsed = !!rule._uiCollapsed;
    if (collapsed) wrap.classList.add('is-collapsed');

    // Header: chevron + editable description + delete
    const header = el('div', { className: 'pp-thr-header' });
    const chevron = el('button', { className: 'pp-thr-chevron', ariaLabel: collapsed ? 'Expand rule' : 'Collapse rule' });
    chevron.textContent = collapsed ? '\u25B8' : '\u25BE';
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      rule._uiCollapsed = !rule._uiCollapsed;
      saveConfig();
      // In-place toggle so scroll position is preserved (a full renderPanel
      // rebuilds the DOM and resets #pp-panel__body.scrollTop).
      const now = !!rule._uiCollapsed;
      outerWrap.classList.toggle('is-collapsed', now);
      chevron.textContent = now ? '\u25B8' : '\u25BE';
      chevron.setAttribute('aria-label', now ? 'Expand rule' : 'Collapse rule');
    });
    // Multi-line auto-expanding description (max 3 lines).
    const descInput = document.createElement('textarea');
    descInput.className = 'pp-thr-desc';
    descInput.rows = 1;
    descInput.value = rule.description || '';
    descInput.placeholder = 'Rule description';
    function autoSize() {
      descInput.style.height = 'auto';
      // ~ line-height 1.35 * 12px = 16.2 => 3 lines ~ 49px + padding
      const max = 62;
      descInput.style.height = Math.min(descInput.scrollHeight, max) + 'px';
    }
    descInput.addEventListener('input', autoSize);
    descInput.addEventListener('change', () => { rule.description = descInput.value; saveConfig(); });
    // Run once inserted (scrollHeight requires DOM attachment)
    setTimeout(autoSize, 0);
    const delBtn = el('button', { className: 'pp-icon', text: '\u00D7', ariaLabel: 'Delete rule' });
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      config.thresholdRules = config.thresholdRules.filter(r => r.id !== rule.id);
      state.firedRules = state.firedRules.filter(id => id !== rule.id);
      saveConfig(); saveState(); renderPanel();
    });
    header.appendChild(chevron);
    header.appendChild(descInput);
    header.appendChild(delBtn);
    wrap.appendChild(header);

    // Everything below the header lives inside pp-thr-body so we can hide it
    // when collapsed via CSS. All subsequent wrap.appendChild calls in this
    // function actually target this body wrapper (we shadow `wrap` locally).
    const outerWrap = wrap;
    const bodyWrap = el('div', { className: 'pp-thr-body' });
    outerWrap.appendChild(bodyWrap);
    // eslint-disable-next-line no-func-assign, no-var
    wrap = bodyWrap;

    // Topic + threshold
    const topicField = el('div', { className: 'pp-thr-field' });
    topicField.appendChild(el('label', { text: 'When' }));
    const topicSel = document.createElement('select');
    for (const t of config.topics) {
      const o = document.createElement('option'); o.value = t.id; o.textContent = t.label;
      if (rule.topicId === t.id) o.selected = true;
      topicSel.appendChild(o);
    }
    topicSel.addEventListener('change', () => { rule.topicId = topicSel.value; saveConfig(); });
    const thrInput = el('input', { type: 'number', value: String(rule.threshold) });
    thrInput.min = '1';
    thrInput.addEventListener('change', () => { rule.threshold = Number(thrInput.value) || 1; saveConfig(); });
    topicField.appendChild(topicSel);
    topicField.appendChild(el('span', { text: '\u2265' }));
    topicField.appendChild(thrInput);
    wrap.appendChild(topicField);

    // Applies-on: single pattern for the editor (advanced users can use JSON for multiple)
    const app = rule.appliesOn && rule.appliesOn[0] ? rule.appliesOn[0] : { pattern: '', kind: 'exact' };
    if (!rule.appliesOn || !rule.appliesOn.length) rule.appliesOn = [app];
    const appField = el('div', { className: 'pp-thr-field' });
    appField.appendChild(el('label', { text: 'On page' }));
    const appPat = el('input', { type: 'text', value: app.pattern, placeholder: '(any page)' });
    appPat.addEventListener('change', () => { app.pattern = appPat.value; rule.appliesOn = [app]; saveConfig(); });
    const appKind = document.createElement('select');
    for (const k of ['exact', 'prefix', 'regex']) {
      const o = document.createElement('option'); o.value = k; o.textContent = k;
      if (app.kind === k) o.selected = true;
      appKind.appendChild(o);
    }
    appKind.style.flex = '0 0 68px';
    appKind.addEventListener('change', () => { app.kind = appKind.value; rule.appliesOn = [app]; saveConfig(); });
    appField.appendChild(appPat);
    appField.appendChild(appKind);
    wrap.appendChild(appField);

    // Action type
    const actField = el('div', { className: 'pp-thr-field' });
    actField.appendChild(el('label', { text: 'Do' }));
    const actSel = document.createElement('select');
    for (const [val, label] of [['swapImage', 'Swap image'], ['popup', 'Show popup'], ['richPopup', 'Popup (AI-designed)'], ['recStrip', 'Recommendations strip'], ['runScript', 'Run script']]) {
      const o = document.createElement('option'); o.value = val; o.textContent = label;
      if (rule.action.type === val) o.selected = true;
      actSel.appendChild(o);
    }
    actSel.addEventListener('change', () => {
      const type = actSel.value;
      // Reset action fields to defaults for the new type but keep selector if present
      const keepSel = rule.action.selector || '';
      if (type === 'swapImage') rule.action = { type, selector: keepSel, image: rule.action.image || '' };
      else if (type === 'popup') rule.action = { type, title: rule.action.title || 'Hello', body: rule.action.body || 'A message for you.', cta: rule.action.cta || null };
      else if (type === 'richPopup') rule.action = { type, intent: rule.action.intent || '', html: rule.action.html || '', css: rule.action.css || '' };
      else if (type === 'recStrip') rule.action = { type, intent: rule.action.intent || '', mode: rule.action.mode || 'replace', target: rule.action.target || '', cards: Array.isArray(rule.action.cards) ? rule.action.cards : [] };
      else rule.action = { type, code: rule.action.code || '// ctx.$(sel) -> element\n// e.g. ctx.$("h1").textContent = "Personalised!";' };
      saveConfig(); renderPanel();
    });
    actField.appendChild(actSel);
    wrap.appendChild(actField);

    // Action-specific fields
    if (rule.action.type === 'swapImage') {
      // Browse is the primary, works-on-any-site way to pick the image to
      // replace; the raw selector + Pick stay as a manual fallback. (The engine
      // still honours a `slot` on saved configs; we just don't author it here.)
      const browseField = el('div', { className: 'pp-thr-field' });
      browseField.appendChild(el('label', { text: 'Replace' }));
      // When the picked element is a <video>, this becomes a video->video swap.
      const onTargetPicked = (sel, elc) => {
        rule.action.selector = sel; delete rule.action.slot;
        const isVid = !!(elc && (elc.tagName === 'VIDEO' || (elc.querySelector && elc.querySelector('video'))));
        rule.action.isVideo = isVid;
        if (isVid) delete rule.action.image; else delete rule.action.video;
        saveConfig(); renderPanel();
      };
      const browseBtn = el('button', { className: 'pp-btn pp-btn--sm', text: '🖼 Browse page images' });
      browseBtn.title = 'Pick the image/video to replace from a gallery of the page’s media';
      browseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startImageGallery(onTargetPicked);
      });
      browseField.appendChild(browseBtn);
      wrap.appendChild(browseField);

      // Raw selector + Pick — manual fallback for a target the gallery can't show.
      const selField = el('div', { className: 'pp-thr-field' });
      selField.appendChild(el('label', { text: 'Target' }));
      const selInput = el('input', { type: 'text', value: rule.action.selector || '', placeholder: rule.action.slot ? ('slot: ' + rule.action.slot) : '.hero, #banner, img.foo' });
      selInput.addEventListener('change', () => {
        rule.action.selector = selInput.value; delete rule.action.slot;
        let node = null; try { node = document.querySelector(selInput.value); } catch (e) { node = null; }
        rule.action.isVideo = !!(node && node.tagName === 'VIDEO');
        saveConfig(); renderPanel();
      });
      const pickBtn = el('button', { className: 'pp-btn pp-btn--sm', text: 'Pick' });
      pickBtn.title = 'Click an element on the page to capture its selector';
      pickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startPick(onTargetPicked);
      });
      selField.appendChild(selInput);
      selField.appendChild(pickBtn);
      wrap.appendChild(selField);

      // Is the target a video? (flag set at pick time, or selector resolves to one.)
      let targetIsVideo = !!rule.action.isVideo;
      if (!targetIsVideo && rule.action.selector) {
        try { const n = document.querySelector(rule.action.selector); if (n && n.tagName === 'VIDEO') targetIsVideo = true; } catch (e) { /* ignore */ }
      }

      if (targetIsVideo) {
        const vidField = el('div', { className: 'pp-thr-field' });
        vidField.appendChild(el('label', { text: 'Video URL' }));
        const vidInput = el('input', { type: 'text', value: rule.action.video || '', placeholder: 'https://\u2026.mp4' });
        vidInput.addEventListener('change', () => { rule.action.video = vidInput.value; saveConfig(); });
        vidField.appendChild(vidInput);
        wrap.appendChild(vidField);
        wrap.appendChild(el('div', { className: 'pp-hint', text: 'This target is a video \u2014 replace it with a video file (.mp4). It autoplays muted.' }));
      } else {
        const imgField = el('div', { className: 'pp-thr-field' });
        imgField.appendChild(el('label', { text: 'Image URL' }));
        const imgInput = el('input', { type: 'text', value: rule.action.image || '', placeholder: 'https://\u2026' });
        imgInput.addEventListener('change', () => { rule.action.image = imgInput.value; saveConfig(); });
        imgField.appendChild(imgInput);
        wrap.appendChild(imgField);
      }
    } else if (rule.action.type === 'popup') {
      const titleField = el('div', { className: 'pp-thr-field' });
      titleField.appendChild(el('label', { text: 'Title' }));
      const titleInput = el('input', { type: 'text', value: rule.action.title || '' });
      titleInput.addEventListener('change', () => { rule.action.title = titleInput.value; saveConfig(); });
      titleField.appendChild(titleInput);
      wrap.appendChild(titleField);

      const bodyField = el('div', { className: 'pp-thr-field' });
      bodyField.appendChild(el('label', { text: 'Body' }));
      const bodyInput = el('input', { type: 'text', value: rule.action.body || '' });
      bodyInput.addEventListener('change', () => { rule.action.body = bodyInput.value; saveConfig(); });
      bodyField.appendChild(bodyInput);
      wrap.appendChild(bodyField);

      const ctaLabelField = el('div', { className: 'pp-thr-field' });
      ctaLabelField.appendChild(el('label', { text: 'CTA text' }));
      const ctaLabelInput = el('input', { type: 'text', value: (rule.action.cta || {}).label || '', placeholder: '(none)' });
      ctaLabelInput.addEventListener('change', () => {
        rule.action.cta = rule.action.cta || {}; rule.action.cta.label = ctaLabelInput.value;
        if (!ctaLabelInput.value && !(rule.action.cta.href)) rule.action.cta = null;
        saveConfig();
      });
      ctaLabelField.appendChild(ctaLabelInput);
      wrap.appendChild(ctaLabelField);

      const ctaHrefField = el('div', { className: 'pp-thr-field' });
      ctaHrefField.appendChild(el('label', { text: 'CTA link' }));
      const ctaHrefInput = el('input', { type: 'text', value: (rule.action.cta || {}).href || '', placeholder: 'https://\u2026' });
      ctaHrefInput.addEventListener('change', () => {
        rule.action.cta = rule.action.cta || {}; rule.action.cta.href = ctaHrefInput.value;
        if (!ctaHrefInput.value && !(rule.action.cta.label)) rule.action.cta = null;
        saveConfig();
      });
      ctaHrefField.appendChild(ctaHrefInput);
      wrap.appendChild(ctaHrefField);
    } else if (rule.action.type === 'richPopup') {
      // Describe-it → gateway designs HTML+CSS. SE can also hand-edit/paste.
      const intentField = el('div');
      intentField.appendChild(el('div', { className: 'pp-rule-meta', text: 'Describe the popup — the gateway designs brand-matched HTML + CSS (mention a form if you want one). Verifies URLs as it goes — can take a bit.' }));
      const intentArea = el('textarea', { className: 'pp-code' });
      intentArea.style.height = '48px';
      intentArea.value = rule.action.intent || '';
      intentArea.placeholder = 'e.g. Luxury concierge offer with an email signup form';
      intentArea.spellcheck = false;
      intentArea.addEventListener('change', () => { rule.action.intent = intentArea.value; saveConfig(); });
      intentField.appendChild(intentArea);
      wrap.appendChild(intentField);

      const designBtn = el('button', { className: 'pp-btn pp-btn--full', text: '✨ Design with gateway' });
      wrap.appendChild(designBtn);
      const designStatus = el('div', { className: 'pp-hint', text: rule.action.html ? 'Design ready — Test now to preview.' : (gatewayKey() ? 'Gateway: ' + gatewayBaseUrl() : 'No gateway key — set it above, or paste HTML/CSS below.') });
      wrap.appendChild(designStatus);
      designBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        rule.action.intent = intentArea.value;
        if (!gatewayKey()) { alert('No gateway key set — add it in the Claude Gateway section above, or paste HTML/CSS in Advanced.'); return; }
        const orig = designBtn.textContent; designBtn.disabled = true; designBtn.textContent = 'Designing…';
        try {
          const out = await gatewayDesignPopup(rule.action.intent);
          rule.action.html = out.html; rule.action.css = out.css || '';
          saveConfig(); renderPanel();
        } catch (err) {
          designBtn.disabled = false; designBtn.textContent = orig;
          designStatus.textContent = '✗ ' + err.message;
        }
      });

      // Advanced: hand-edit or paste HTML/CSS (also the no-gateway fallback).
      const details = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = 'Advanced: edit HTML / CSS';
      if (rule.action.html) details.open = false;
      details.appendChild(summary);
      const htmlArea = el('textarea', { className: 'pp-code' });
      htmlArea.value = rule.action.html || ''; htmlArea.placeholder = '<div>…</div>'; htmlArea.spellcheck = false;
      htmlArea.addEventListener('change', () => { rule.action.html = htmlArea.value; saveConfig(); });
      const cssArea = el('textarea', { className: 'pp-code' });
      cssArea.value = rule.action.css || ''; cssArea.placeholder = '/* CSS (scoped to the popup) */'; cssArea.spellcheck = false;
      cssArea.addEventListener('change', () => { rule.action.css = cssArea.value; saveConfig(); });
      details.appendChild(el('div', { className: 'pp-rule-meta', text: 'HTML' }));
      details.appendChild(htmlArea);
      details.appendChild(el('div', { className: 'pp-rule-meta', text: 'CSS' }));
      details.appendChild(cssArea);
      wrap.appendChild(details);
    } else if (rule.action.type === 'recStrip') {
      if (!Array.isArray(rule.action.cards)) rule.action.cards = [];
      if (!rule.action.mode) rule.action.mode = 'replace';

      const intentField = el('div');
      intentField.appendChild(el('div', { className: 'pp-rule-meta', text: 'Describe the recommendations — the gateway drafts the cards and verifies the images resolve; you edit image + text below. Replaces an existing card row on the page so it blends in. Can take a bit.' }));
      const intentArea = el('textarea', { className: 'pp-code' });
      intentArea.style.height = '44px';
      intentArea.value = rule.action.intent || '';
      intentArea.placeholder = 'e.g. 4 Sri Lanka specialists / related tours';
      intentArea.spellcheck = false;
      intentArea.addEventListener('change', () => { rule.action.intent = intentArea.value; saveConfig(); });
      intentField.appendChild(intentArea);
      wrap.appendChild(intentField);

      const designBtn = el('button', { className: 'pp-btn pp-btn--full', text: '✨ Draft cards with gateway' });
      wrap.appendChild(designBtn);
      // Detection status: show which row we'll replace.
      const best = detectBestCardRow();
      const detText = rule.action.target
        ? ('Target row: ' + rule.action.target)
        : (best ? ('Will replace detected card row (' + best.count + ' cards)') : 'No card row detected — a new strip will be added.');
      const designStatus = el('div', { className: 'pp-hint', text: detText });
      wrap.appendChild(designStatus);
      designBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        rule.action.intent = intentArea.value;
        if (!gatewayKey()) { alert('No gateway key set — add it in the Claude Gateway section above, or add cards by hand below.'); return; }
        const orig = designBtn.textContent; designBtn.disabled = true; designBtn.textContent = 'Drafting…';
        try {
          const out = await gatewayDesignRecStrip(rule.action.intent);
          rule.action.cards = out.cards; rule.action.mode = out.mode; rule.action.target = out.target || '';
          saveConfig(); renderPanel();
        } catch (err) {
          designBtn.disabled = false; designBtn.textContent = orig;
          designStatus.textContent = '✗ ' + err.message;
        }
      });

      // Mode toggle + Pick row.
      const modeField = el('div', { className: 'pp-thr-field' });
      modeField.appendChild(el('label', { text: 'Mode' }));
      const modeSel = document.createElement('select');
      for (const [v, l] of [['replace', 'Replace existing row'], ['add', 'Add a new strip']]) {
        const o = document.createElement('option'); o.value = v; o.textContent = l;
        if (rule.action.mode === v) o.selected = true; modeSel.appendChild(o);
      }
      modeSel.addEventListener('change', () => { rule.action.mode = modeSel.value; saveConfig(); });
      const pickRowBtn = el('button', { className: 'pp-btn pp-btn--sm', text: 'Pick row' });
      pickRowBtn.title = 'Click a card on the page; its row becomes the target';
      pickRowBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        startPick((sel, elc) => {
          // Map the clicked element up to its card-row container.
          const row = detectCardRows().find(r => r.container.contains(elc)) ;
          rule.action.target = row ? uniqueSelector(row.container) : sel;
          saveConfig(); renderPanel();
        });
      });
      modeField.appendChild(modeSel);
      modeField.appendChild(pickRowBtn);
      wrap.appendChild(modeField);

      // Per-card editors.
      wrap.appendChild(el('div', { className: 'pp-rule-meta', text: 'Cards (' + rule.action.cards.length + ')' }));
      rule.action.cards.forEach((card, idx) => {
        if (!Array.isArray(card.lines)) card.lines = [];
        const cardBox = el('div', { className: 'pp-rs-cardedit' });
        // Image row: url + Browse + remove-card
        const imgRow = el('div', { className: 'pp-thr-field' });
        imgRow.appendChild(el('label', { text: '#' + (idx + 1) + ' img' }));
        const imgIn = el('input', { type: 'text', value: card.image || '', placeholder: 'image URL' });
        imgIn.addEventListener('change', () => { card.image = imgIn.value; saveConfig(); });
        const browse = el('button', { className: 'pp-btn pp-btn--sm', text: 'Browse' });
        browse.addEventListener('click', (ev) => {
          ev.stopPropagation();
          startImageGallery((sel, elc) => {
            const im = elc && (elc.tagName === 'IMG' ? elc : elc.querySelector && elc.querySelector('img'));
            card.image = (im && (im.currentSrc || im.src)) || card.image;
            saveConfig(); renderPanel();
          });
        });
        const delCard = el('button', { className: 'pp-icon', text: '×', title: 'Remove card' });
        delCard.addEventListener('click', (ev) => { ev.stopPropagation(); rule.action.cards.splice(idx, 1); saveConfig(); renderPanel(); });
        imgRow.appendChild(imgIn); imgRow.appendChild(browse); imgRow.appendChild(delCard);
        cardBox.appendChild(imgRow);
        // Text lines
        const linesText = el('textarea', { className: 'pp-code' });
        linesText.style.height = '46px';
        linesText.value = card.lines.join('\n');
        linesText.placeholder = 'One line of text per row\n(name, title, blurb…)';
        linesText.spellcheck = false;
        linesText.addEventListener('change', () => { card.lines = linesText.value.split('\n').map(s => s.trim()).filter(Boolean); saveConfig(); });
        cardBox.appendChild(linesText);
        wrap.appendChild(cardBox);
      });
      const addCardBtn = el('button', { className: 'pp-btn pp-btn--sm', text: '+ Add card' });
      addCardBtn.addEventListener('click', (ev) => { ev.stopPropagation(); rule.action.cards.push({ image: '', lines: [] }); saveConfig(); renderPanel(); });
      wrap.appendChild(addCardBtn);

    } else if (rule.action.type === 'runScript') {
      // Describe-it -> gateway writes the JS into the code box; SE reviews + Tests.
      const intentField = el('div');
      intentField.appendChild(el('div', { className: 'pp-rule-meta', text: 'Describe the change for the gateway to script (e.g. "replace the hero video with an image at <url> and stop the video"). Verifies as it goes — can take a bit.' }));
      const intentArea = el('textarea', { className: 'pp-code' });
      intentArea.style.height = '44px';
      intentArea.value = rule.action.scriptIntent || '';
      intentArea.placeholder = 'Describe what to change\u2026';
      intentArea.spellcheck = false;
      intentArea.addEventListener('change', () => { rule.action.scriptIntent = intentArea.value; saveConfig(); });
      intentField.appendChild(intentArea);
      wrap.appendChild(intentField);

      const designBtn = el('button', { className: 'pp-btn pp-btn--full', text: '\u2728 Design with gateway' });
      wrap.appendChild(designBtn);
      const designStatus = el('div', { className: 'pp-hint', text: gatewayKey() ? 'Gateway: ' + gatewayBaseUrl() + ' \u2014 writes JS into the box below; review then Test now.' : 'No gateway key \u2014 set it in Claude Gateway, or write JS by hand below.' });
      wrap.appendChild(designStatus);
      designBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        rule.action.scriptIntent = intentArea.value;
        if (!gatewayKey()) { alert('No gateway key set \u2014 add it in the Claude Gateway section, or write JS by hand.'); return; }
        const orig = designBtn.textContent; designBtn.disabled = true; designBtn.textContent = 'Writing\u2026';
        try {
          rule.action.code = await gatewayDesignScript(rule.action.scriptIntent);
          saveConfig(); renderPanel();
        } catch (err) {
          designBtn.disabled = false; designBtn.textContent = orig;
          designStatus.textContent = '\u2717 ' + err.message;
        }
      });

      const codeField = el('div');
      const codeLabel = el('div', { className: 'pp-rule-meta', text: 'JS runs in the page with `rule` and `ctx` in scope \u2014 ctx.$(sel), ctx.$$(sel), ctx.state (visitor topic scores), ctx.config, ctx.log(\u2026). Normal DOM/fetch APIs are available too. Review, then Test now.' });
      const codeArea = el('textarea', { className: 'pp-code' });
      codeArea.value = rule.action.code || '';
      codeArea.spellcheck = false;
      codeArea.addEventListener('change', () => { rule.action.code = codeArea.value; saveConfig(); });
      codeField.appendChild(codeLabel);
      codeField.appendChild(codeArea);
      wrap.appendChild(codeField);
    }

    // Fired badge + Test / Un-fire
    const fired = state.firedRules.includes(rule.id);
    const rowActions = el('div', { className: 'pp-thr-actions' });
    const testBtn = el('button', { className: 'pp-btn pp-btn--sm', text: fired ? 'Re-run test' : 'Test now' });
    testBtn.title = 'Run this rule\'s action once (does not touch scores)';
    testBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const fn = actions[rule.action.type];
      if (!fn) { alert('Unknown action type: ' + rule.action.type); return; }
      const ok = fn(rule);
      if (!ok) alert('Rule ran but returned no effect \u2014 check selector / URL / console.');
    });
    const unfireBtn = el('button', { className: 'pp-btn pp-btn--sm', text: fired ? 'Un-fire' : 'Not fired' });
    if (!fired) unfireBtn.disabled = true, unfireBtn.style.opacity = 0.5;
    unfireBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (rule.action.type === 'recStrip') restoreRecStrip(rule);
      state.firedRules = state.firedRules.filter(id => id !== rule.id);
      saveState(); renderPanel();
    });
    rowActions.appendChild(testBtn);
    rowActions.appendChild(unfireBtn);
    wrap.appendChild(rowActions);

    return outerWrap;
  }

  // -------------------- Config view --------------------
  function renderConfig(body) {
    // AI author \u2014 first thing in Config so it's discoverable
    body.appendChild(el('h4', { text: 'AI author' }));
    const aiBtn = el('button', { className: 'pp-btn pp-btn--full', text: '\u2728 Generate config with AI' });
    aiBtn.addEventListener('click', (e) => { e.stopPropagation(); openAiPromptModal(); });
    body.appendChild(aiBtn);
    body.appendChild(el('div', { className: 'pp-hint', text: 'Copy a prompt for ChatGPT/Claude, or wire up the gateway below to generate in one click.' }));

    // Claude Gateway \u2014 connect the inline "Generate with gateway" button.
    // Stored in `ui` (local only): never exported with a story, never clobbered
    // by importing one.
    body.appendChild(el('h4', { text: 'Claude Gateway' }));

    // One-click connect: ask the local gateway (via Tampermonkey's privileged
    // request) for its key + current tunnel URL, so there's no copy-paste.
    const connectBtn = el('button', { className: 'pp-btn pp-btn--full', text: '⚡ Connect to local gateway' });
    body.appendChild(connectBtn);
    const connectStatus = el('div', { className: 'pp-hint', text: 'Fetches the key + current tunnel URL from your local gateway (needs the Tampermonkey userscript).' });
    body.appendChild(connectStatus);
    connectBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const orig = connectBtn.textContent; connectBtn.disabled = true; connectBtn.textContent = 'Connecting…';
      try {
        const out = await bootstrapFromLocalGateway();
        connectStatus.textContent = '✓ Connected — using ' + out.url;
        renderPanel();
      } catch (err) {
        connectBtn.disabled = false; connectBtn.textContent = orig;
        connectStatus.textContent = '✗ ' + err.message;
      }
    });

    const gwUrlRow = el('div', { className: 'pp-row' });
    const gwUrlInput = el('input', { type: 'text', value: ui.gateway.url || '', placeholder: 'http://localhost:4000' });
    gwUrlInput.addEventListener('change', () => { ui.gateway.url = gwUrlInput.value.trim(); saveUi(); });
    gwUrlRow.appendChild(gwUrlInput);
    body.appendChild(gwUrlRow);

    const gwKeyRow = el('div', { className: 'pp-row' });
    const gwKeyInput = el('input', { type: 'password', value: ui.gateway.key || '', placeholder: 'Gateway key' });
    gwKeyInput.autocomplete = 'off';
    gwKeyInput.addEventListener('change', () => { ui.gateway.key = gwKeyInput.value.trim(); saveUi(); });
    const gwTestBtn = el('button', { className: 'pp-btn pp-btn--sm', text: 'Test' });
    gwTestBtn.title = 'Check the gateway is reachable (GET /health)';
    gwKeyRow.appendChild(gwKeyInput);
    gwKeyRow.appendChild(gwTestBtn);
    body.appendChild(gwKeyRow);

    const gwStatus = el('div', { className: 'pp-hint', text: 'URL + key for the Claude Gateway. Stays on this machine; not saved in exported stories.' });
    body.appendChild(gwStatus);
    gwTestBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Persist latest field values before testing.
      ui.gateway.url = gwUrlInput.value.trim(); ui.gateway.key = gwKeyInput.value.trim(); saveUi();
      gwTestBtn.disabled = true; const orig = gwTestBtn.textContent; gwTestBtn.textContent = '\u2026';
      gwStatus.textContent = 'Checking ' + gatewayBaseUrl() + '/health \u2026';
      const res = await gatewayHealth();
      gwTestBtn.disabled = false; gwTestBtn.textContent = orig;
      gwStatus.textContent = res.ok
        ? '\u2713 Gateway reachable at ' + gatewayBaseUrl() + (gatewayKey() ? '' : ' (add a key to generate)')
        : '\u2717 ' + gatewayBaseUrl() + ': ' + res.reason;
    });

    // This site \u2014 the update-proof allowlist. Scope lives here (data), not in
    // the userscript @match, so it survives Tampermonkey auto-updates.
    body.appendChild(el('h4', { text: 'Where it runs' }));
    body.appendChild(el('div', { className: 'pp-current-url pp-url', text: window.location.hostname || '(local)' }));
    const stopBtn = el('button', { className: 'pp-btn pp-btn--full pp-btn--danger', text: 'Stop running on this site' });
    stopBtn.title = 'Removes this site from the allowlist and reloads \u2014 the panel goes dormant here';
    stopBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleCurrentSite(); });
    body.appendChild(stopBtn);
    const sites = getAllowedSites();
    const siteList = el('ul');
    if (!sites.length) siteList.appendChild(el('li', { className: 'pp-empty', text: 'No sites allow-listed' }));
    else for (const sEntry of sites) {
      const li = el('li');
      li.appendChild(el('span', { className: 'pp-url', text: sEntry }));
      const del = el('button', { className: 'pp-icon', text: '\u00d7', ariaLabel: 'Remove site', title: 'Remove site' });
      del.addEventListener('click', (e) => { e.stopPropagation(); removeSite(sEntry); renderPanel(); });
      li.appendChild(del);
      siteList.appendChild(li);
    }
    body.appendChild(siteList);
    body.appendChild(el('div', { className: 'pp-hint', text: 'Scope persists across userscript updates (stored as data, not in @match). Enable other sites from the Tampermonkey menu.' }));

    // Persona avatar \u2014 shown inside the collapsed badge
    body.appendChild(el('h4', { text: 'Persona avatar' }));
    const personaRow = el('div', { className: 'pp-persona-row' });
    const libBtn = el('button', { className: 'pp-persona-lib', ariaLabel: 'Choose from library', title: 'Choose from library' });
    libBtn.textContent = '\u25be'; // down-pointing triangle
    if (config.avatarUrl) {
      const preview = document.createElement('img');
      preview.src = config.avatarUrl; preview.className = 'pp-persona-preview';
      libBtn.textContent = '';
      libBtn.appendChild(preview);
    }
    const urlInput = el('input', { type: 'text', className: 'pp-persona-input', value: config.avatarUrl || '', placeholder: 'https://\u2026image.png  or pick from library' });
    const clearBtn = el('button', { className: 'pp-persona-clear', ariaLabel: 'Clear avatar', title: 'Clear', text: '\u00d7' });
    personaRow.appendChild(libBtn);
    personaRow.appendChild(urlInput);
    personaRow.appendChild(clearBtn);
    body.appendChild(personaRow);
    body.appendChild(el('div', { className: 'pp-hint', text: 'Shown inside the badge when the panel is collapsed. Leave empty for the Salesforce cloud default.' }));

    urlInput.addEventListener('change', () => {
      config.avatarUrl = urlInput.value.trim();
      saveConfig(); renderPanel();
    });
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      config.avatarUrl = ''; saveConfig(); renderPanel();
    });
    libBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePersonaLibrary(libBtn, urlInput);
    });

    // Topics
    body.appendChild(el('h4', { text: 'Topics' }));
    const topicList = el('ul');
    if (!config.topics.length) topicList.appendChild(el('li', { className: 'pp-empty', text: 'No topics \u2014 add one below' }));
    else {
      for (const t of config.topics) {
        const li = el('li');
        const input = el('input', { className: 'pp-topic-edit', type: 'text', value: t.label });
        input.addEventListener('change', () => { t.label = input.value.trim() || t.id; saveConfig(); renderPanel(); });
        const del = el('button', { className: 'pp-icon', text: '\u00D7', ariaLabel: 'Delete topic', title: 'Delete topic' });
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          config.topics = config.topics.filter(x => x.id !== t.id);
          config.urlRules = config.urlRules.filter(r => r.topicId !== t.id);
          config.thresholdRules = config.thresholdRules.filter(r => r.topicId !== t.id);
          delete state.scores[t.id];
          saveConfig(); saveState(); renderPanel();
        });
        li.appendChild(input);
        li.appendChild(del);
        topicList.appendChild(li);
      }
    }
    body.appendChild(topicList);

    const addTopicRow = el('div', { className: 'pp-row' });
    const newTopicInput = el('input', { type: 'text', placeholder: 'New topic name\u2026' });
    const addTopicBtn = el('button', { className: 'pp-btn pp-btn--sm', text: 'Add' });
    addTopicRow.appendChild(newTopicInput);
    addTopicRow.appendChild(addTopicBtn);
    body.appendChild(addTopicRow);
    addTopicBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const label = newTopicInput.value.trim();
      if (!label) return;
      config.topics.push({ id: shortId('topic'), label });
      saveConfig(); renderPanel();
    });
    newTopicInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTopicBtn.click(); } });

    // Tag this page
    body.appendChild(el('h4', { text: 'Tag this page' }));
    const currentUrl = el('div', { className: 'pp-current-url pp-url', text: window.location.pathname + window.location.search + window.location.hash });
    body.appendChild(currentUrl);

    const tagRow = el('div', { className: 'pp-row' });
    const topicSelect = el('select');
    if (!config.topics.length) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = '(no topics)';
      topicSelect.appendChild(opt);
      topicSelect.disabled = true;
    } else {
      for (const t of config.topics) {
        const opt = document.createElement('option');
        opt.value = t.id; opt.textContent = t.label;
        topicSelect.appendChild(opt);
      }
    }
    const weightInput = el('input', { className: 'pp-weight', type: 'number', value: '1' });
    weightInput.min = '-100'; weightInput.max = '100'; weightInput.step = '1';
    const addRuleBtn = el('button', { className: 'pp-btn pp-btn--sm', text: 'Add rule' });
    tagRow.appendChild(topicSelect);
    tagRow.appendChild(weightInput);
    tagRow.appendChild(addRuleBtn);
    body.appendChild(tagRow);
    addRuleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!config.topics.length) return;
      const pattern = window.location.pathname + window.location.search + window.location.hash;
      config.urlRules.push({
        id: shortId('rule'),
        pattern,
        kind: 'exact',
        topicId: topicSelect.value || config.topics[0].id,
        weight: Number(weightInput.value) || 1
      });
      saveConfig(); renderPanel();
    });

    // Existing URL rules
    body.appendChild(el('h4', { text: 'URL rules (' + config.urlRules.length + ')' }));
    const ruleList = el('ul');
    if (!config.urlRules.length) ruleList.appendChild(el('li', { className: 'pp-empty', text: 'No URL rules yet' }));
    else {
      for (const r of config.urlRules) {
        const li = el('li');
        const rbody = el('div', { className: 'pp-rule-body' });
        const patInput = el('input', { type: 'text', value: r.pattern });
        patInput.addEventListener('change', () => { r.pattern = patInput.value; saveConfig(); });
        const meta = el('div', { className: 'pp-rule-meta' });
        const topicLabel = (config.topics.find(t => t.id === r.topicId) || {}).label || r.topicId;

        const kindSel = document.createElement('select');
        for (const k of ['exact', 'prefix', 'regex']) {
          const o = document.createElement('option'); o.value = k; o.textContent = k;
          if (r.kind === k) o.selected = true;
          kindSel.appendChild(o);
        }
        kindSel.style.fontSize = '10px';
        kindSel.addEventListener('change', () => { r.kind = kindSel.value; saveConfig(); });

        const topicSel = document.createElement('select');
        for (const t of config.topics) {
          const o = document.createElement('option'); o.value = t.id; o.textContent = t.label;
          if (r.topicId === t.id) o.selected = true;
          topicSel.appendChild(o);
        }
        topicSel.style.fontSize = '10px';
        topicSel.addEventListener('change', () => { r.topicId = topicSel.value; saveConfig(); renderPanel(); });

        const wInput = document.createElement('input');
        wInput.type = 'number'; wInput.value = String(r.weight); wInput.style.width = '48px'; wInput.style.fontSize = '10px';
        wInput.addEventListener('change', () => { r.weight = Number(wInput.value) || 1; saveConfig(); });

        meta.appendChild(kindSel);
        meta.appendChild(document.createTextNode(' \u2192 '));
        meta.appendChild(topicSel);
        meta.appendChild(document.createTextNode(' \u00D7 '));
        meta.appendChild(wInput);
        rbody.appendChild(patInput);
        rbody.appendChild(meta);
        li.appendChild(rbody);
        const del = el('button', { className: 'pp-icon', text: '\u00D7', ariaLabel: 'Delete rule', title: 'Delete rule' });
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          config.urlRules = config.urlRules.filter(x => x.id !== r.id);
          saveConfig(); renderPanel();
        });
        li.appendChild(del);
        ruleList.appendChild(li);
      }
    }
    body.appendChild(ruleList);

    // Threshold rules \u2014 the "what happens when" configuration
    body.appendChild(el('h4', { text: 'Threshold rules (' + config.thresholdRules.length + ')' }));
    const thrList = el('div');
    if (!config.thresholdRules.length) thrList.appendChild(el('div', { className: 'pp-empty', text: 'No threshold rules yet' }));
    else for (const r of config.thresholdRules) thrList.appendChild(renderThresholdRule(r));
    body.appendChild(thrList);

    const addThrBtn = el('button', { className: 'pp-btn pp-btn--full', text: '+ Add threshold rule for this page' });
    addThrBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentPath = window.location.pathname + window.location.search;
      config.thresholdRules.push({
        id: shortId('thr'),
        description: 'New rule',
        topicId: (config.topics[0] || {}).id || '',
        threshold: 3,
        appliesOn: [{ pattern: currentPath, kind: 'exact' }],
        action: { type: 'swapImage', selector: '', image: '' }
      });
      saveConfig(); renderPanel();
    });
    body.appendChild(addThrBtn);

    // Danger zone / Export / Import
    const actionsRow = el('div', { className: 'pp-actions-row' });
    const rescoreBtn = el('button', { className: 'pp-btn', text: 'Re-score & clear' });
    const wipeBtn = el('button', { className: 'pp-btn pp-btn--danger', text: 'Wipe config' });
    actionsRow.appendChild(rescoreBtn);
    actionsRow.appendChild(wipeBtn);
    body.appendChild(actionsRow);
    rescoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state = { scores: {}, firedRules: [], scoredUrls: [] };
      saveState();
      scoreCurrentPage();
      renderPanel();
    });
    wipeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Wipe all config (topics + URL rules + threshold rules) and reset to defaults?')) return;
      config = defaultConfig();
      state = { scores: {}, firedRules: [], scoredUrls: [] };
      saveConfig(); saveState(); renderPanel();
    });

    // Import / Export \u2014 real file operations
    body.appendChild(el('h4', { text: 'Save / load story' }));
    const ioRow = el('div', { className: 'pp-actions-row' });
    const exportBtn = el('button', { className: 'pp-btn', text: '\u2B07 Export' });
    const importBtn = el('button', { className: 'pp-btn', text: '\u2B06 Import' });
    ioRow.appendChild(exportBtn);
    ioRow.appendChild(importBtn);
    body.appendChild(ioRow);
    body.appendChild(el('div', { className: 'pp-hint', text: 'Exports a JSON file: web_perso_story__<site>__<date>.json' }));

    exportBtn.addEventListener('click', (e) => { e.stopPropagation(); exportStoryFile(); });
    importBtn.addEventListener('click', (e) => { e.stopPropagation(); openImportPicker(); });

    // Advanced fallback \u2014 kept behind a details toggle for copy-paste flows
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Advanced: copy/paste JSON';
    details.appendChild(summary);
    const jsonArea = el('textarea', { className: 'pp-json' });
    jsonArea.value = JSON.stringify(config, null, 2);
    details.appendChild(jsonArea);
    const paRow = el('div', { className: 'pp-actions-row' });
    const copyBtn = el('button', { className: 'pp-btn pp-btn--sm', text: 'Copy' });
    const applyBtn = el('button', { className: 'pp-btn pp-btn--sm', text: 'Apply' });
    paRow.appendChild(copyBtn);
    paRow.appendChild(applyBtn);
    details.appendChild(paRow);
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(jsonArea.value); copyBtn.textContent = 'Copied \u2713'; setTimeout(() => copyBtn.textContent = 'Copy', 1500); }
      catch (err) { jsonArea.select(); }
    });
    applyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try { applyImportedConfig(JSON.parse(jsonArea.value)); }
      catch (err) { alert('Invalid JSON: ' + err.message); }
    });
    body.appendChild(details);
  }

  // -------------------- AI authoring prompt --------------------
  // Assemble a prompt that teaches the LLM our config schema + authoring
  // rules, primes it with the current site + a few example URLs from the
  // user's existing rules, and leaves a slot for the user's intent.
  function buildAiPrompt(userIntent) {
    const host = window.location.hostname || '(no host)';
    const origin = window.location.origin || '';
    const seedUrls = new Set();
    seedUrls.add(window.location.href);
    for (const r of config.urlRules) {
      // Combine pattern with origin if it looks like a path
      if (r.pattern.startsWith('/')) seedUrls.add(origin + r.pattern);
      else seedUrls.add(r.pattern);
    }
    for (const t of config.thresholdRules) {
      for (const a of (t.appliesOn || [])) if (a.pattern) {
        if (a.pattern.startsWith('/')) seedUrls.add(origin + a.pattern);
        else seedUrls.add(a.pattern);
      }
    }
    const urlList = [...seedUrls].slice(0, 6).map(u => '  - ' + u).join('\n');

    // Named slots exposed by the current page (data-personalise* convention).
    // The engine can target these by name, so the AI should prefer them over
    // brittle CSS selectors for swapImage actions.
    const slots = (typeof discoverSlots === 'function') ? discoverSlots() : [];
    const slotList = slots.length
      ? slots.map(s => `  - ${s.name}${s.kind === 'section' ? ' (section)' : ''}`).join('\n')
      : '  (none found on this page — use CSS selectors instead)';

    const intent = userIntent && userIntent.trim()
      ? userIntent.trim()
      : '<< Describe what you want the personalisation to accomplish. Examples:\n'
        + '   - "Boost Sri Lanka interest \u2014 swap homepage hero and CTA copy for anyone who has viewed 3+ Sri Lanka pages."\n'
        + '   - "Highlight family holidays for repeat visitors who\'ve clicked family destinations."\n'
        + '   - "Nudge premium travel \u2014 show a popup with a concierge CTA after 5 luxury-tier page views." >>';

    return `You are helping author a JSON config for a client-side website
personalisation engine called Personalise (web_perso_story format).

TARGET SITE
Base URL: ${origin || '(unknown \u2014 user is running locally)'}
Hostname: ${host}
Example URLs to look at first:
${urlList}

NAMED SLOTS on the current page (prefer these as swapImage targets)
These are stable, friendly targets the engine can address by name instead of a
CSS selector. For any swapImage action, use "slot": "<name>" below rather than
"selector" whenever one fits:
${slotList}

WHAT I WANT (user intent)
${intent}

YOUR TASK
1. Crawl the target site starting from the example URLs above. Look at the
   real HTML \u2014 identify hero blocks, CTAs, navigation, section headings,
   and any content you'd want to personalise for the intent above.
2. Propose 2\u20135 topics that capture the segments the intent implies.
3. Propose urlRules that map URL patterns \u2192 topic weights so browsing the
   site accumulates topic scores naturally. Prefer prefix or regex rules
   that cover a section rather than an exact path per page.
4. Propose thresholdRules that swap images, show popups, or run scripts
   when a topic score meets its threshold. Only add rules that make sense
   for the intent \u2014 don't invent noise.
5. For each thresholdRule, include an appliesOn pattern so it doesn't fire
   on unrelated pages. Leave appliesOn empty only for site-wide effects.
6. Return ONE JSON object, no prose around it, matching the exact schema
   below. Do not wrap it in markdown code fences.

SCHEMA (must match exactly \u2014 engine imports this verbatim)
{
  "_kind": "web_perso_story",
  "_version": 1,
  "_exportedAt": "<ISO 8601 timestamp>",
  "_sourceHost": "${host}",
  "config": {
    "client": "<human name for this configuration, e.g. Audley Sri Lanka boost>",
    "topics": [
      { "id": "<kebab-case-id>", "label": "<human label>" }
    ],
    "urlRules": [
      {
        "id": "<unique id>",
        "pattern": "<string>",           // path, URL, prefix ending in *, or /regex/flags
        "kind": "exact" | "prefix" | "regex",
        "topicId": "<matches one topics[].id>",
        "weight": <integer, typically 1..5, can be negative>
      }
    ],
    "thresholdRules": [
      {
        "id": "<unique id>",
        "description": "<one-line human description>",
        "topicId": "<matches one topics[].id>",
        "threshold": <integer, typically 2..10>,
        "appliesOn": [
          { "pattern": "<string>", "kind": "exact" | "prefix" | "regex" }
        ],
        "action": <ACTION>
      }
    ]
  }
}

ACTION VARIANTS

Swap image (background-image or <img src>):
Preferred form — target a named slot from the list above (selector-free):
{ "type": "swapImage", "slot": "<slot name>", "image": "<absolute image URL>" }
Fallback form — only when no slot fits, target a raw CSS selector:
{ "type": "swapImage", "selector": "<CSS selector>", "image": "<absolute image URL>" }

Show popup (simple fixed template):
{ "type": "popup",
  "title": "<string>",
  "body": "<string>",
  "cta": { "label": "<button text>", "href": "<url>" }   // optional
}

AI-designed popup (brand-matched HTML + CSS; use for richer layouts or a form):
{ "type": "richPopup",
  "html": "<self-contained popup markup. NO <script>/<iframe>/external resources.
           Define your own classes. Do NOT include a backdrop or close button \u2014
           the engine adds those. For a form, use labelled inputs + a submit button.>",
  "css":  "<CSS targeting the classes you defined; it is scoped to the popup box>"
}

Recommendations strip (structured cards; engine clones an existing card row to
match the site's styling, or injects a generic strip if none exists):
{ "type": "recStrip",
  "mode": "replace" | "add",
  "target": "<CSS selector of the card-row container to replace (optional)>",
  "cards": [ { "image": "<image URL or empty>", "lines": ["Name", "Title", "Short blurb"] } ]
}

Run script (arbitrary DOM tweaks \u2014 use ONLY when swapImage/popup can't cover it):
{ "type": "runScript",
  "code": "<JS body. \`rule\` and \`ctx\` are in scope; normal DOM/fetch APIs too. Helpers:\n  ctx.$(sel) -> first element\n  ctx.$$(sel) -> all elements\n  ctx.state -> visitor signals {scores, firedRules, scoredUrls}\n  ctx.config -> full config (topics, rules)\n  ctx.log(...) -> console.info. Write robust, idempotent code; guard missing elements; no cookie writes or sending page data to third parties>"
}

AUTHORING RULES
- Topic IDs must be kebab-case (sri-lanka-interest, family-focused, etc.).
- Weights: 1 is the default per-page contribution. Use higher weights
  (2\u20133) for hub / landing pages and 4+ only for very high-signal pages.
- For swapImage, ALWAYS prefer a named slot ("slot": "...") from the NAMED SLOTS
  list over a CSS selector. Only fall back to "selector" when no slot fits.
- When a selector is unavoidable, prefer semantic CSS selectors (BEM-style:
  .brand-hero__title, .cta__button) over deep :nth-of-type() chains. If the site
  uses utility-class frameworks (Tailwind etc.), prefer data-* attributes or
  aria-label selectors.
- Only pick images you can verify are hotlink-safe. Prefer the target
  site's own CDN, or open-license hosts (Wikimedia Commons). Never invent URLs.
- If runScript is unavoidable, keep the snippet short (<20 lines) and
  never touch localStorage / cookies / fetch / navigate.
- appliesOn should be tight. A homepage-hero swap should appliesOn the
  homepage only, not everywhere.
- Set _exportedAt to the current UTC timestamp in ISO 8601 format.

STRING ENCODING (IMPORTANT - do not skip)
- Every string value in the JSON output must be pure 7-bit ASCII.
- If a description, topic label, popup body, or runScript code needs a
  non-ASCII character (em dash, arrow, sparkles, curly quotes, accented
  letters, any emoji), encode it as a JSON \\uXXXX escape sequence.
  Examples (left = what to output, right = what it decodes to for the user):
    "Sri Lanka \\u2014 cultural triangle"     ->  Sri Lanka + em dash + cultural triangle
    "\\u2728 Highlight for repeat visitors"    ->  sparkles + Highlight...
    "Caf\\u00e9 & Concierge"                    ->  Caf + e-acute + " & Concierge"
    "Ready \\u2192 start your journey"        ->  Ready + right-arrow + start...
- Do NOT emit raw multi-byte UTF-8 characters. They get mangled by some
  clipboard / editor / import pipelines and render as mojibake in the UI.
- Never use "smart" curly quotes or typographic dashes; prefer plain
  ASCII ' " - unless the \\uXXXX escape form is used.
- JSON parsers decode \\uXXXX to the correct Unicode codepoint at parse
  time, so the escaped form displays exactly the same to the user AND is
  immune to encoding pipeline corruption.

OUTPUT (deliver as a downloadable JSON file)
Produce a real JSON FILE for me to download, not just JSON text in chat.

- File name (use exactly this): web_perso_story__${host}__${todayStamp()}.json
- File contents: ONLY the JSON object described above. No prose, no code
  fences, no comments, no trailing text. Must parse cleanly with JSON.parse.
- Every string value must be pure ASCII (with \\uXXXX escapes where needed).
- Use your interface's file / attachment / canvas / artifact feature so I
  can click a download link and save the .json to disk in one step.
- If your interface truly cannot produce a downloadable file, print the
  JSON as ONE fenced code block labelled json and explicitly tell me to
  save it with the filename above. In that case, still keep the response
  content itself as JSON only -- no prose around the fence.

I will import that file directly into the Personalise panel via
Config -> Save/load story -> Import.`;
  }

  // -------------------- Claude Gateway client --------------------
  // The gateway wraps a human's Claude login behind a small HTTP server, so
  // there's no provider API key / per-token billing. We send the gateway key on
  // every call and keep calls self-contained (no server-side memory).
  function gatewayBaseUrl() {
    return (ui.gateway && ui.gateway.url ? ui.gateway.url : 'http://localhost:4000').replace(/\/+$/, '');
  }
  function gatewayKey() { return (ui.gateway && ui.gateway.key || '').trim(); }

  // A cross-origin fetch that is blocked by CORS throws a TypeError that is
  // indistinguishable from a genuine network failure — the browser hides the
  // real reason for security. When the page's origin differs from the gateway
  // origin, a thrown fetch is very likely CORS, so we say so.
  function isCrossOrigin() {
    try { return new URL(gatewayBaseUrl()).origin !== window.location.origin; }
    catch (e) { return true; }
  }
  function fetchFailureHint() {
    return isCrossOrigin()
      ? 'unreachable, or the browser blocked it (CORS). If curl works but this does not, the gateway needs CORS headers — see gateway-cors-patch.md.'
      : 'unreachable — is it running?';
  }

  // GET /health — no key needed. Returns { ok, reason } (never throws) so the
  // UI can explain *why* it failed, not just that it did.
  async function gatewayHealth() {
    let r;
    try {
      r = await fetch(gatewayBaseUrl() + '/health', { method: 'GET' });
    } catch (e) {
      return { ok: false, reason: fetchFailureHint() };
    }
    if (!r.ok) return { ok: false, reason: 'returned HTTP ' + r.status };
    const j = await r.json().catch(() => ({}));
    return (j && j.ok) ? { ok: true } : { ok: false, reason: 'responded but not healthy' };
  }

  // POST /complete — one prompt in, text out. Throws with a readable message so
  // callers can show it to the SE.
  async function gatewayComplete(prompt, system) {
    const key = gatewayKey();
    if (!key) throw new Error('No gateway key set — add it in Config → Claude Gateway.');
    let r;
    try {
      r = await fetch(gatewayBaseUrl() + '/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(system ? { prompt, system } : { prompt })
      });
    } catch (e) {
      throw new Error('Gateway at ' + gatewayBaseUrl() + ' ' + fetchFailureHint());
    }
    if (r.status === 401) throw new Error('Gateway rejected the key (401) — check / refresh it.');
    if (!r.ok) throw new Error('Gateway error ' + r.status);
    const j = await r.json().catch(() => ({}));
    if (typeof j.text !== 'string') throw new Error('Gateway returned no text.');
    return j.text;
  }

  // -------------------- Local-gateway bootstrap (GM_xmlhttpRequest) --------------------
  // The demo runs on a customer HTTPS site; browsers block it from calling
  // http://localhost (mixed content). Tampermonkey's GM_xmlhttpRequest issues
  // the request from the extension context, bypassing mixed-content AND CORS, so
  // we can reach the SE's local gateway. We use it ONLY for the one localhost
  // bootstrap call; actual /complete calls still go over the HTTPS tunnel.
  function hasGM() { return typeof GM_xmlhttpRequest === 'function'; }
  function bootstrapUrl() {
    return ((ui.gateway && ui.gateway.bootstrapUrl) || 'http://localhost:4000').replace(/\/+$/, '');
  }
  // Promise wrapper around GM_xmlhttpRequest for a simple GET returning JSON.
  function gatewayGM(method, url, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      try {
        GM_xmlhttpRequest({
          method: method, url: url, timeout: timeoutMs || 8000,
          onload: (res) => { if (done) return; done = true; resolve({ status: res.status, text: res.responseText }); },
          onerror: () => { if (done) return; done = true; reject(new Error('request failed')); },
          ontimeout: () => { if (done) return; done = true; reject(new Error('timed out')); }
        });
      } catch (e) { reject(e); }
    });
  }

  // Call the local gateway's localhost-only /bootstrap (no key) to fetch
  // { key, tunnelUrl }, then store them so all later calls use the HTTPS tunnel.
  async function bootstrapFromLocalGateway() {
    if (!hasGM()) {
      throw new Error('Connect needs the Tampermonkey userscript (GM_xmlhttpRequest). Paste the URL + key manually instead.');
    }
    const res = await gatewayGM('GET', bootstrapUrl() + '/bootstrap', 8000);
    if (res.status === 404) throw new Error('Gateway has no /bootstrap endpoint — see gateway-bootstrap-patch.md.');
    if (res.status < 200 || res.status >= 300) throw new Error('Bootstrap returned HTTP ' + res.status + ' (is the local gateway running?).');
    let j;
    try { j = JSON.parse(res.text); } catch (e) { throw new Error('Bootstrap returned invalid JSON.'); }
    const tunnelUrl = typeof j.tunnelUrl === 'string' ? j.tunnelUrl.trim() : '';
    const key = typeof j.key === 'string' ? j.key.trim() : '';
    if (!/^https?:\/\//i.test(tunnelUrl)) throw new Error('Bootstrap did not return a usable tunnelUrl.');
    if (!key) throw new Error('Bootstrap did not return a key.');
    ui.gateway = ui.gateway || {};
    ui.gateway.url = tunnelUrl.replace(/\/+$/, '');
    ui.gateway.key = key;
    saveUi();
    return { url: ui.gateway.url };
  }

  // Ask the gateway to DESIGN a single popup as self-contained HTML + CSS,
  // brand-matched to the current site (the LLM infers the look). Returns
  // { html, css }. Fence/prose tolerant.
  async function gatewayDesignPopup(intent) {
    const host = window.location.hostname || '(local)';
    const headings = Array.from(document.querySelectorAll('h1, h2'))
      .slice(0, 3).map(h => (h.textContent || '').trim()).filter(Boolean);
    const system = 'You are a web designer. You output a single modal popup as self-contained '
      + 'HTML plus a CSS block, visually matched to the brand of the given website. '
      + 'Return ONLY a JSON object: {"html":"...","css":"..."}. Rules: no <script>, no '
      + '<iframe>, no external stylesheets or JS, no tracking. Inline SVG/text is fine. '
      + 'Keep it one centered modal’s worth of markup (no backdrop/close button — the host adds those). '
      + 'If a form is requested, include labelled inputs and a submit button (the host '
      + 'intercepts submit). CSS selectors should target classes you define inside the popup.';
    const prompt = 'Website: ' + host + '\n'
      + (document.title ? 'Page title: ' + document.title + '\n' : '')
      + (headings.length ? 'Visible headings: ' + headings.join(' | ') + '\n' : '')
      + 'Design this popup: ' + (intent && intent.trim() ? intent.trim() : 'a tasteful promotional offer with a clear call to action')
      + '\n\nReturn only the JSON object.';
    const parsed = await gatewayAgent(
      system + '\n\n' + prompt + '\nVerify that any URLs you include actually resolve.',
      { html: 'string', css: 'string' },
      { host: host, title: document.title }
    );
    if (!parsed || typeof parsed.html !== 'string' || !parsed.html.trim()) {
      throw new Error('Gateway response had no html field.');
    }
    return { html: parsed.html, css: typeof parsed.css === 'string' ? parsed.css : '' };
  }

  // Ask the gateway to BOTH place and design a recommendations strip. Returns
  // { at:{selector,position}, html, css }. We give it the page's landmark
  // elements so it can pick a real anchor.
  // Ask the gateway for STRUCTURED recommendation cards (not HTML). We detect an
  // existing card row to match (count + sample text) so the model mirrors the
  // site's tone/length; the engine clones that row to render. Returns
  // { mode, target, count, cards:[{image, lines[]}] }.
  async function gatewayDesignRecStrip(intent) {
    const host = window.location.hostname || '(local)';
    const row = detectBestCardRow();
    let targetSel = '', count = 4, sample = '';
    if (row) {
      targetSel = uniqueSelector(row.container);
      count = Math.min(row.count, 6);
      // Sample text from the first card so the model matches length/tone.
      const first = row.cardEls[0];
      sample = Array.from(first.querySelectorAll('h1,h2,h3,h4,p,span'))
        .map(n => (n.textContent || '').trim()).filter(Boolean).slice(0, 4).join(' | ');
    }
    const system = 'You write content for a row of recommendation cards on a web page. '
      + 'Return ONLY a JSON object: {"cards":[{"image":"<image URL or empty string>",'
      + '"lines":["line1","line2",...]}]}. Each card has 2-3 SHORT text lines (e.g. name, '
      + 'title/subtitle, one-line blurb). Match the length and tone of the sample card text. '
      + 'For "image", find a public, hotlink-safe image matching the card and VERIFY the URL '
      + 'actually resolves (HTTP 200, image content-type) before using it; if you cannot verify '
      + 'one, leave it an empty string. No markup, no HTML.';
    const prompt = 'Website: ' + host + '\n'
      + (document.title ? 'Page title: ' + document.title + '\n' : '')
      + (sample ? 'Sample existing card text (match this style/length): ' + sample + '\n' : '')
      + 'Number of cards: ' + count + '\n'
      + 'Recommendations to show: ' + (intent && intent.trim() ? intent.trim() : 'a few relevant items for this page')
      + '\n\nReturn only the JSON object.';
    const parsed = await gatewayAgent(
      system + '\n\n' + prompt,
      { cards: [{ image: 'string', lines: ['string'] }] },
      { host: host, title: document.title, sample: sample, count: count, intent: intent || '' }
    );
    const rawCards = Array.isArray(parsed && parsed.cards) ? parsed.cards : [];
    if (!rawCards.length) throw new Error('Gateway response had no cards.');
    const cards = rawCards.map(c => ({
      image: typeof c.image === 'string' ? c.image : '',
      lines: Array.isArray(c.lines) ? c.lines.map(String) : (typeof c.lines === 'string' ? [c.lines] : [])
    }));
    return { mode: row ? 'replace' : 'add', target: targetSel, count, cards };
  }

  // Ask the gateway to write a runScript JS body from a plain-language intent.
  // The snippet runs with `rule` and `ctx` in scope (see makeCtx). Returns the
  // JS string (fences + any function wrapper stripped); the SE reviews + Tests.
  async function gatewayDesignScript(intent) {
    const host = window.location.hostname || '(local)';
    // A few landmark selectors so the model can target real elements.
    const landmarks = [];
    const seen = new Set();
    for (const sel of ['main', 'section', '[class*="hero"]', 'video', '[class*="card"]', 'footer']) {
      const node = document.querySelector(sel);
      if (node && !seen.has(node)) {
        seen.add(node);
        const cls = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        landmarks.push('  - ' + sel + '  (' + node.tagName.toLowerCase() + (cls ? '.' + cls : '') + ')');
      }
      if (landmarks.length >= 6) break;
    }
    const system = 'You write the JavaScript BODY of a web-page personalisation snippet. '
      + 'It runs in the page, with `rule` and `ctx` already in scope. Available API:\n'
      + '  ctx.$(sel)   -> first matching element (or null)\n'
      + '  ctx.$$(sel)  -> array of all matching elements\n'
      + '  ctx.state    -> visitor signals: {scores:{<topicId>:number}, firedRules:[id], scoredUrls:[url]} '
      + '(how interested the visitor is in each topic, from pages they viewed)\n'
      + '  ctx.config   -> the full config, incl. config.topics (topic ids + labels) and config.thresholdRules\n'
      + '  ctx.log(...) -> console.info for debugging\n'
      + 'You may also use the normal DOM/browser APIs directly (document, window, Image, '
      + 'IntersectionObserver, fetch to LOAD images/JSON/content, and navigation/CTA changes '
      + 'when the task calls for them).\n'
      + 'Write ROBUST code, not the shortest possible: guard against missing elements, handle the '
      + 'case where there are several matches, and wait for late-loading elements when needed (e.g. a '
      + 'short MutationObserver or a bounded poll) rather than assuming everything exists at run time. '
      + 'The snippet may run more than once, so make it idempotent (don’t stack duplicate changes). '
      + 'Tailor behaviour to ctx.state when that improves the result.\n'
      + 'Safety: do NOT write cookies, do NOT send the page’s data to third-party servers '
      + '(no exfiltration), and do NOT eval or inject remote code.\n'
      + 'Return ONLY the JavaScript body — no markdown fences, no function wrapper, no explanation.';
    // Capture the REAL rendered HTML (cleaned: no scripts/styles/SVGs/hidden/panel).
    // Gzip at the transport level keeps it under the tunnel ceiling.
    var pageHtml = '';
    try { pageHtml = captureLiveHtml(); } catch (e) { /* no capture */ }
    var prompt = 'Website: ' + host + '\n'
      + (document.title ? 'Page title: ' + document.title + '\n' : '')
      + (landmarks.length ? 'Landmark elements:\n' + landmarks.join('\n') + '\n' : '')
      + (pageHtml
        ? 'The LIVE rendered HTML of the page body is provided in context.html. '
          + 'This is the real markup with real classes, ids, data attributes, and text. '
          + 'Base every CSS selector on this actual structure. Do not guess class names. '
          + 'Do not match an element by walking all elements and checking textContent '
          + '(that resolves to the body or html element). Instead, target the specific '
          + 'element by its class, id, or data attribute as shown in the HTML.\n'
        : '')
      + 'Change to make: ' + (intent && intent.trim() ? intent.trim() : 'describe a DOM change')
      + '\n\nReturn only the JavaScript body.';
    // Text mode -- gatewayAgent returns the raw body string.
    // HTML goes in context.html; the whole POST body is gzip-compressed at the
    // transport level inside gatewayAgent (Content-Encoding: gzip).
    var ctx = { host: host, title: document.title };
    if (pageHtml) ctx.html = pageHtml;
        let text = await gatewayAgent(system + '\n\n' + prompt, null, ctx);
    text = String(text).trim().replace(/^```(?:js|javascript)?\s*/i, '').replace(/```\s*$/i, '').trim();
    // Unwrap an accidental function/arrow wrapper so we store a plain body.
    const fn = text.match(/^(?:function\s*\w*\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{([\s\S]*)\}\s*;?$/);
    if (fn) text = fn[1].trim();
    if (!text) throw new Error('Gateway returned an empty script.');
    return text;
  }

  // General agentic call: run the gateway's Claude Code worker as a tool-using
  // agent (constrained tools — fetch/search, no shell) on a natural-language
  // task, looping to completion. For slow pre-demo "research + verify" work
  // (e.g. check every rec image resolves and fix broken ones). Returns parsed
  // JSON (j.result, else fence-tolerant parse of j.text). Long timeout.
  async function gatewayAgent(task, schema, context) {
    const key = gatewayKey();
    if (!key) throw new Error('No gateway key set — add it in Config → Claude Gateway.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000); // agent loops are slow
    // Gzip the body at the transport level (Content-Encoding: gzip) so large
    // payloads (e.g. 60 KB DOM skeletons in context.dom) fit through the
    // Cloudflare quick-tunnel. The gateway accepts gzip and decompresses
    // before parsing JSON.
    var jsonStr = JSON.stringify({ task: task, schema: schema || null, context: context || null });
    var fetchBody, contentEncoding;
    try {
      var cs = new CompressionStream('gzip');
      var stream = new Response(new Blob([new TextEncoder().encode(jsonStr)]).stream().pipeThrough(cs));
      fetchBody = await stream.arrayBuffer();
      contentEncoding = 'gzip';
    } catch (gzErr) {
      // CompressionStream not available (very old browser) -- send uncompressed.
      fetchBody = jsonStr;
      contentEncoding = null;
    }
    var hdrs = { 'Content-Type': 'application/json', 'x-api-key': key };
    if (contentEncoding) hdrs['Content-Encoding'] = contentEncoding;
    let r;
    try {
      r = await fetch(gatewayBaseUrl() + '/agent', {
        method: 'POST', headers: hdrs, body: fetchBody, signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('Agent timed out (over 3 min).');
      throw new Error('Gateway at ' + gatewayBaseUrl() + ' ' + fetchFailureHint());
    }
    clearTimeout(timer);
    if (r.status === 404) throw new Error('Gateway has no /agent endpoint — see gateway-agent-patch.md.');
    if (r.status === 401) throw new Error('Gateway rejected the key (401) — check / refresh it.');
    if (!r.ok) throw new Error('Gateway agent error ' + r.status);
    const j = await r.json().catch(() => ({}));
    // Text mode: no schema requested -> return the raw text (fence-stripped) as a
    // string (used for code bodies). Structured mode -> parsed JSON object.
    if (!schema) {
      const t = typeof j.text === 'string' ? j.text : (typeof j.result === 'string' ? j.result : '');
      const stripped = t.trim().replace(/^```(?:js|javascript|json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      if (!stripped) throw new Error('Agent returned empty output.');
      return stripped;
    }
    if (j && j.result && typeof j.result === 'object') return j.result;
    if (typeof j.text === 'string') {
      const cleaned = j.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      try { return JSON.parse(cleaned); } catch (e) { throw new Error('Agent returned non-JSON output.'); }
    }
    throw new Error('Agent returned no usable result.');
  }

  function openAiPromptModal() {
    // Reuse popup-style modal
    if (document.getElementById('pp-ai-modal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'pp-ai-modal';
    const backdrop = document.createElement('div'); backdrop.className = 'pp-ai-backdrop';
    const box = document.createElement('div'); box.className = 'pp-ai-box';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pp-ai-close'; closeBtn.textContent = '\u00D7'; closeBtn.setAttribute('aria-label', 'Close');

    const title = document.createElement('h3'); title.textContent = 'AI-author a config';
    const sub = document.createElement('div'); sub.className = 'pp-ai-sub';
    sub.textContent = 'Describe what you want — Generate with gateway drafts and verifies it (can take a bit), or copy the prompt into ChatGPT/Claude and paste the JSON back.';

    const intentLabel = document.createElement('label'); intentLabel.textContent = 'What should the personalisation do?';
    intentLabel.className = 'pp-ai-label';
    const intentArea = document.createElement('textarea'); intentArea.className = 'pp-ai-intent'; intentArea.rows = 3;
    intentArea.placeholder = 'e.g. Boost Sri Lanka interest \u2014 swap the homepage hero and CTA for anyone who has viewed 3+ Sri Lanka pages.';

    const genBtn = document.createElement('button'); genBtn.className = 'pp-btn'; genBtn.textContent = '\u26A1 Generate with gateway';
    const copyBtn = document.createElement('button'); copyBtn.className = 'pp-btn'; copyBtn.textContent = '\uD83D\uDCCB Copy prompt';

    const rowA = document.createElement('div'); rowA.className = 'pp-ai-row';
    rowA.appendChild(genBtn);
    rowA.appendChild(copyBtn);

    const gwStatus = document.createElement('div'); gwStatus.className = 'pp-ai-sub'; gwStatus.style.marginTop = '6px';
    gwStatus.textContent = gatewayKey()
      ? 'Gateway: ' + gatewayBaseUrl()
      : 'No gateway key set \u2014 add it in Config \u2192 Claude Gateway, or use Copy prompt.';

    const outLabel = document.createElement('label'); outLabel.textContent = 'Paste the AI\'s JSON response here';
    outLabel.className = 'pp-ai-label pp-ai-label--gap';
    const outArea = document.createElement('textarea'); outArea.className = 'pp-ai-output'; outArea.rows = 8;
    outArea.placeholder = '{ "_kind": "web_perso_story", ... }';

    const applyBtn = document.createElement('button'); applyBtn.className = 'pp-btn'; applyBtn.textContent = 'Apply config';
    const rowB = document.createElement('div'); rowB.className = 'pp-ai-row';
    rowB.appendChild(applyBtn);

    box.appendChild(closeBtn);
    box.appendChild(title);
    box.appendChild(sub);
    box.appendChild(intentLabel);
    box.appendChild(intentArea);
    box.appendChild(rowA);
    box.appendChild(gwStatus);
    box.appendChild(outLabel);
    box.appendChild(outArea);
    box.appendChild(rowB);
    wrap.appendChild(backdrop);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    function close() { wrap.remove(); }
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);

    // Parse a model's reply and import it. Accepts a raw string (code-fence
    // tolerant) or an already-parsed object (e.g. from gatewayAgent).
    function parseAndApply(raw) {
      let parsed;
      if (raw && typeof raw === 'object') {
        parsed = raw;
      } else {
        const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
        parsed = JSON.parse(cleaned);
      }
      const cfg = parsed && parsed._kind === 'web_perso_story' && parsed.config ? parsed.config : parsed;
      applyImportedConfig(cfg);
    }

    genBtn.addEventListener('click', async () => {
      if (!gatewayKey()) { alert('No gateway key set — add it in Config → Claude Gateway first (or use Copy prompt).'); return; }
      const original = genBtn.textContent;
      genBtn.disabled = true; genBtn.textContent = 'Generating…';
      try {
        const prompt = buildAiPrompt(intentArea.value)
          + '\n\nVerify that any image or link URLs you include actually resolve (HTTP 200); replace broken ones.';
        // Route through the agent so it can self-verify URLs. It returns the
        // parsed config object directly (schema-shaped).
        const out = await gatewayAgent(prompt, { _kind: 'string', config: 'object' }, { host: location.host });
        outArea.value = JSON.stringify(out, null, 2); // show what came back, so the SE can inspect/tweak
        parseAndApply(out);
        genBtn.textContent = 'Applied ✓';
        setTimeout(close, 700);
      } catch (err) {
        genBtn.disabled = false; genBtn.textContent = original;
        alert('Gateway generate failed: ' + err.message
          + (outArea.value ? '\n\nThe raw response is in the box below — you can fix and Apply it manually.' : ''));
      }
    });

    copyBtn.addEventListener('click', async () => {
      const prompt = buildAiPrompt(intentArea.value);
      try {
        await navigator.clipboard.writeText(prompt);
        copyBtn.textContent = 'Copied \u2713';
        setTimeout(() => copyBtn.textContent = '\uD83D\uDCCB Copy prompt', 1500);
      } catch (err) {
        // Fallback: fill outArea so user can copy manually
        outArea.value = prompt; outArea.focus(); outArea.select();
        alert('Clipboard blocked \u2014 prompt placed in the response box. Copy from there.');
      }
    });

    applyBtn.addEventListener('click', () => {
      const raw = outArea.value.trim();
      if (!raw) { alert('Paste the AI\'s JSON output first.'); return; }
      try {
        parseAndApply(raw);
        close();
      } catch (err) { alert('Import failed: ' + err.message); }
    });
  }

  // -------------------- Story export / import --------------------
  function todayStamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function safeHost() {
    return (window.location.hostname || 'local').replace(/[^a-z0-9.-]/gi, '_') || 'local';
  }
  function exportStoryFile() {
    const filename = `web_perso_story__${safeHost()}__${todayStamp()}.json`;
    // Wrap config with a small envelope so we can validate + version imports later
    const payload = {
      _kind: 'web_perso_story',
      _version: 1,
      _exportedAt: new Date().toISOString(),
      _sourceHost: window.location.hostname,
      config
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function openImportPicker() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          // Accept both envelope form (from Export) and raw config form (for compat)
          const cfg = parsed && parsed._kind === 'web_perso_story' && parsed.config ? parsed.config : parsed;
          applyImportedConfig(cfg);
        } catch (err) { alert('Import failed: ' + err.message); }
      };
      reader.onerror = () => alert('Could not read file');
      reader.readAsText(file);
    });
    input.click();
  }
  function applyImportedConfig(parsed) {
    if (!parsed || !Array.isArray(parsed.topics) || !Array.isArray(parsed.urlRules)) {
      throw new Error('Not a valid web_perso_story config (missing topics/urlRules)');
    }
    config = Object.assign(defaultConfig(), parsed);
    saveConfig();
    renderPanel();
  }

  // -------------------- SPA navigation --------------------
  function installNavigationHooks() {
    const emit = () => window.dispatchEvent(new Event('personalise:navigate'));
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () { const r = origPush.apply(this, arguments); emit(); return r; };
    history.replaceState = function () { const r = origReplace.apply(this, arguments); emit(); return r; };
    window.addEventListener('popstate', emit);
    window.addEventListener('personalise:navigate', () => {
      // Pre-apply CSS overrides immediately \u2014 happens synchronously in the
      // route change tick, before the new view has painted. The MutationObserver
      // takes care of catching newly-inserted <img> elements as the SPA renders.
      preApplyPaintedRules();
      // Slight delay to let the SPA render new content before selectors + panel
      // rely on it. Re-apply fired rules to the possibly-replaced DOM nodes.
      setTimeout(() => {
        scoreCurrentPage();
        applyFiredRulesToLiveDOM();
        evaluateRules();
        preApplyPaintedRules();
        renderPanel();
      }, 50);
    });
  }

  // -------------------- Zero-flicker pre-paint --------------------
  // For rules that (a) already meet threshold or (b) already fired previously,
  // apply them BEFORE the browser paints:
  //   - Inject a <style> block that overrides background-image via CSS
  //   - Inject <link rel=preload as=image> for the swap targets
  //   - Install a MutationObserver that catches <img> elements matching the
  //     selector as they enter the DOM and rewrites src before first paint
  // This works even before <body> exists because we append to documentElement.
  let __ppObserver = null;
  const __ppImgTargets = new Map(); // selector -> imageUrl (fresh each preApply run)

  function shouldPreApply(rule) {
    if (rule.action.type !== 'swapImage') return false;
    if (!rule.action.image) return false;
    if (!rule.action.selector && !rule.action.slot) return false;
    if (!ruleApplies(rule)) return false;
    const score = state.scores[rule.topicId] || 0;
    // Pre-apply if score is already \u2265 threshold OR the rule has already fired
    // (fired-set rehydrates across reloads and SPA nav).
    return score >= rule.threshold || state.firedRules.includes(rule.id);
  }

  function preApplyPaintedRules() {
    __ppImgTargets.clear();

    // 1. Build CSS + preload set for eligible rules
    const cssRules = [];
    const preloads = [];
    for (const rule of config.thresholdRules) {
      if (!shouldPreApply(rule)) continue;
      // Resolve slot rules to a concrete selector against the live DOM. If the
      // slot can't be resolved yet (element not painted), skip pre-apply this
      // run — the live-DOM re-fire and evaluateRules paths still catch it.
      let sel = rule.action.selector;
      if (rule.action.slot) {
        const target = resolveSlotTarget(rule.action.slot, 'image');
        if (!target) continue;
        sel = uniqueSelector(target);
      }
      if (!sel) continue;
      const img = rule.action.image;
      // Background-image swap (safe as CSS override).
      // Escaping URL quotes: use the URL as-is; if a user pastes a URL with
      // a single quote it'll be malformed either way.
      cssRules.push(`${sel} { background-image: url('${img.replace(/'/g, "\\'")}') !important; background-size: cover; }`);
      // Preload the image so a subsequent <img src> swap doesn't network-flash
      preloads.push(img);
      // Track for <img src> intercept
      __ppImgTargets.set(sel, img);
    }

    // 2. Inject / replace <style id=pp-preapply>
    let styleEl = document.getElementById('pp-preapply');
    if (cssRules.length) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'pp-preapply';
        (document.head || document.documentElement).appendChild(styleEl);
      }
      styleEl.textContent = cssRules.join('\n');
    } else if (styleEl) {
      styleEl.remove();
    }

    // 3. Preload links (idempotent \u2014 dedupe by href)
    const existingPreloads = new Set(
      Array.from(document.querySelectorAll('link[rel="preload"][data-pp]')).map(l => l.href)
    );
    for (const url of preloads) {
      if (existingPreloads.has(url)) continue;
      const link = document.createElement('link');
      link.rel = 'preload'; link.as = 'image'; link.href = url; link.setAttribute('data-pp', '1');
      (document.head || document.documentElement).appendChild(link);
    }

    // 4. Immediately try to swap any <img> already in the DOM
    for (const [sel, img] of __ppImgTargets) {
      document.querySelectorAll(sel).forEach(node => {
        if (node.tagName === 'IMG' && node.src !== img) {
          node.src = img;
          if (node.hasAttribute('srcset')) node.removeAttribute('srcset');
        }
      });
    }

    // 5. Install / refresh MutationObserver for <img> elements not yet in DOM.
    // We check each added node (and their descendants) against every tracked selector.
    if (__ppObserver) __ppObserver.disconnect();
    if (__ppImgTargets.size) {
      __ppObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            for (const [sel, img] of __ppImgTargets) {
              try {
                const matches = [];
                if (node.matches && node.matches(sel)) matches.push(node);
                if (node.querySelectorAll) node.querySelectorAll(sel).forEach(x => matches.push(x));
                for (const el of matches) {
                  if (el.tagName === 'IMG') {
                    if (el.src !== img) el.src = img;
                    if (el.hasAttribute('srcset')) el.removeAttribute('srcset');
                  } else {
                    // background-image element \u2014 CSS already handles it, but set
                    // inline as a belt-and-braces guard.
                    el.style.backgroundImage = `url('${img}')`;
                  }
                }
              } catch (e) { /* invalid selector \u2014 ignore */ }
            }
          }
        }
      });
      __ppObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  // Imperatively swap already-fired rules on the current live DOM. Used after
  // SPA navigation replaces the target element (its `src` was set by the new
  // route's markup; we need to overwrite it).
  function applyFiredRulesToLiveDOM() {
    for (const rule of config.thresholdRules) {
      if (!state.firedRules.includes(rule.id)) continue;
      if (!ruleApplies(rule)) continue;
      // Re-apply the visual, DOM-anchored actions after an SPA route swap.
      // Both are idempotent (swapImage re-sets the same value; recStrip removes
      // any prior instance before re-inserting), so no duplicates.
      if (rule.action.type === 'swapImage') actions.swapImage(rule);
      else if (rule.action.type === 'recStrip') actions.recStrip(rule);
    }
  }

  // -------------------- Boot --------------------
  function boot() {
    // 1. Score the current URL (increments topic scores based on urlRules).
    scoreCurrentPage();
    // 2. Pre-apply CSS + observer for image swaps whose threshold is met.
    //    This runs BEFORE evaluateRules so the paint isn't dependent on
    //    finding the DOM node first.
    preApplyPaintedRules();
    // 3. Now fire any non-visual actions (popup, runScript) and mark rules
    //    fired that weren't fired before. evaluateRules will also re-swap
    //    background/img \u2014 that's fine, it's the same value.
    evaluateRules();
    // 4. Re-run pre-apply so newly-fired rules get their CSS/preload/observer
    //    in place for any SPA route changes coming next.
    preApplyPaintedRules();
    renderPanel();
    installNavigationHooks();
    // If trainer mode was on last session, re-enable it now that DOM is ready.
    if (ui.trainer) refreshTrainer();
    console.info('[personalise] engine ready', { client: config.client, mode: ui.mode, state });
  }

  // -------------------- Site gate --------------------
  // Scoping lives in the allowlist (data), not @match (metadata), so it survives
  // Tampermonkey auto-updates. Register the enable/disable menu command ALWAYS
  // (so a dormant site can be enabled from the Tampermonkey tray), then bail out
  // completely on sites that aren't allowed.
  const ENABLED = currentHostAllowed();
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Personalise: ' + (ENABLED ? 'disable' : 'enable') + ' on this site', toggleCurrentSite);
    }
  } catch (e) { /* ignore */ }

  if (!ENABLED) {
    console.info('[personalise] dormant \u2014 ' + (window.location.hostname || 'this site')
      + ' is not in the allowlist. Enable it from the Tampermonkey menu'
      + (typeof GM_registerMenuCommand === 'function' ? '' : ' (or call personaliseEnableHere()).'));
  } else {
    // Run pre-apply as EARLY as possible \u2014 even before DOMContentLoaded. This is
    // what stops the flicker for background-image swaps: the CSS lands before the
    // browser has painted the target element.
    preApplyPaintedRules();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
