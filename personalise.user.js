// ==UserScript==
// @name         Personalise (rimantas757/web_perso_sim)
// @namespace    https://rimantas757.github.io/web_perso_sim
// @version      2026.08.21.1227
// @description  Client-side personalisation engine — tag pages, score topics, fire swap/popup/script actions.
// @author       rimantas757
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @updateURL    https://rimantas757.github.io/web_perso_sim/personalise.user.js
// @downloadURL  https://rimantas757.github.io/web_perso_sim/personalise.user.js
// @supportURL   https://github.com/rimantas757/web_perso_sim/issues
// @homepageURL  https://github.com/rimantas757/web_perso_sim
// ==/UserScript==

/* ============================================================
 * Personalise.js — reusable client-side personalisation engine
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
  // Generic — no client-specific rules. User builds up rules in Config mode.
  function defaultConfig() {
    return {
      client: 'Generic',
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

  let config = loadJSON(CONFIG_STORAGE_KEY, null);
  if (!config) { config = defaultConfig(); saveJSON(CONFIG_STORAGE_KEY, config); }
  let state = loadJSON(STATE_STORAGE_KEY, { scores: {}, firedRules: [], scoredUrls: [] });
  let ui = loadJSON(UI_STORAGE_KEY, { mode: 'runtime', collapsed: false });

  function saveConfig() { saveJSON(CONFIG_STORAGE_KEY, config); }
  function saveState() { saveJSON(STATE_STORAGE_KEY, state); }
  function saveUi() { saveJSON(UI_STORAGE_KEY, ui); }

  // -------------------- URL matching --------------------
  function patternMatches(pattern, kind, url, path) {
    if (kind === 'exact') return path === pattern || url === pattern;
    if (kind === 'prefix') {
      // Prefix ends in "*" — strip and check
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

  const actions = {
    // swapImage handles both <img> src and background-image on any element.
    swapImage(rule) {
      const el = document.querySelector(rule.action.selector);
      if (!el) { console.warn(`[personalise] selector not found: ${rule.action.selector}`); return false; }
      const image = rule.action.image;
      if (!image) { console.warn('[personalise] swapImage missing image'); return false; }
      if (el.tagName === 'IMG') {
        el.src = image;
        if (el.srcset) el.removeAttribute('srcset');
      } else {
        el.style.backgroundImage = `url('${image}')`;
        el.style.backgroundSize = el.style.backgroundSize || 'cover';
      }
      return true;
    },
    // Legacy alias — old configs referenced swapBackground.
    swapBackground(rule) { return actions.swapImage(rule); },
    popup(rule) {
      if (document.getElementById('personalise-popup')) return true;
      const wrap = document.createElement('div');
      wrap.id = 'personalise-popup';
      const backdrop = document.createElement('div'); backdrop.className = 'pp-popup__backdrop';
      const box = document.createElement('div'); box.className = 'pp-popup__box';
      const closeBtn = document.createElement('button'); closeBtn.className = 'pp-popup__close';
      closeBtn.setAttribute('aria-label', 'Close'); closeBtn.textContent = '×';
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
    // Escape hatch: run an arbitrary JS snippet with access to a ctx helper bag.
    // Only run configs you trust — same trust model as a bookmarklet.
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
    #pp-panel__header { display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; background: #4d726d; color: #fff; cursor: grab; user-select: none; touch-action: none; }
    #pp-panel__header.is-dragging { cursor: grabbing; }
    #pp-panel__header strong { font-weight: 600; letter-spacing: 0.4px; }
    #pp-panel__client { font-size: 10px; opacity: 0.85; }
    #pp-panel__toggle { background: transparent; border: 0; color: #fff; font-size: 16px; cursor: pointer; padding: 0 4px; }
    #pp-panel__body { padding: 12px 14px; max-height: 60vh; overflow-y: auto; }

    /* Expanded header — flex layout for title / client / minus button. */
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
    #pp-panel .pp-thr-rule .pp-thr-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px; }
    #pp-panel .pp-thr-rule .pp-thr-header input { flex: 1; padding: 4px 6px; font-size: 12px; font-weight: 600; border: 1px solid transparent; background: transparent; }
    #pp-panel .pp-thr-rule .pp-thr-header input:focus { border-color: #4d726d; background: #fff; outline: none; }
    #pp-panel .pp-thr-field { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    #pp-panel .pp-thr-field label { flex: 0 0 68px; font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    #pp-panel .pp-thr-field input, #pp-panel .pp-thr-field select { flex: 1; padding: 4px 6px; font-size: 11px; border: 1px solid #d8d8d8; border-radius: 3px; background: #fff; }
    #pp-panel .pp-thr-field input[type=number] { flex: 0 0 60px; }
    #pp-panel .pp-thr-actions { display: flex; gap: 6px; margin-top: 6px; }
    #pp-panel .pp-thr-actions .pp-btn { flex: 1; }

    /* Pick-element overlay — a fixed div on top of the current hovered element */
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
    hint.innerHTML = 'Click any element to capture its selector — press <kbd>Esc</kbd> to cancel';
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

  // -------------------- Panel rendering --------------------
  // Inline Salesforce cloud — schematic form made of overlapping white circles
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

    clear(panel);

    // Header — same element for both expanded and collapsed; content swaps via CSS
    const header = el('div', { id: 'pp-panel__header' });
    header.title = ui.collapsed ? 'Drag to move · click + to expand' : 'Drag to move';

    // Collapsed content: Salesforce cloud badge + expand (+) button
    const badge = el('div', { className: 'pp-badge-content' });
    badge.innerHTML = SF_CLOUD_SVG;
    header.appendChild(badge);
    const expandBtn = el('button', { className: 'pp-expand-btn', ariaLabel: 'Expand', text: '+' });
    header.appendChild(expandBtn);

    // Expanded content: title + client + collapse (−) button
    const expandedHeader = el('div', { className: 'pp-expanded-header' });
    const headerLeft = el('div');
    headerLeft.appendChild(el('strong', { text: 'Personalise' }));
    headerLeft.appendChild(el('div', { id: 'pp-panel__client', text: config.client }));
    const toggleBtn = el('button', { id: 'pp-panel__toggle', ariaLabel: 'Minimise', text: '−' });
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

    // Apply saved position after body is in DOM so offsetWidth/Height are correct
    applyPositionToPanel(panel);

    // Wiring — drag first so it can suppress the trailing click on move.
    // Header itself no longer toggles collapse; only the − / + buttons do,
    // so users can grab-and-drag the header without accidentally minimising.
    attachDrag(panel, header);
    toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); ui.collapsed = true; saveUi(); renderPanel(); });
    expandBtn.addEventListener('click', (e) => { e.stopPropagation(); ui.collapsed = false; saveUi(); renderPanel(); });
    runtimeTab.addEventListener('click', (e) => { e.stopPropagation(); ui.mode = 'runtime'; saveUi(); renderPanel(); });
    configTab.addEventListener('click', (e) => { e.stopPropagation(); ui.mode = 'config'; saveUi(); renderPanel(); });
  }

  // -------------------- Runtime view --------------------
  function renderRuntime(body) {
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
    const wrap = el('div', { className: 'pp-thr-rule' });

    // Header: editable description + delete
    const header = el('div', { className: 'pp-thr-header' });
    const descInput = el('input', { type: 'text', value: rule.description || '' });
    descInput.addEventListener('change', () => { rule.description = descInput.value; saveConfig(); });
    const delBtn = el('button', { className: 'pp-icon', text: '×', ariaLabel: 'Delete rule' });
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      config.thresholdRules = config.thresholdRules.filter(r => r.id !== rule.id);
      state.firedRules = state.firedRules.filter(id => id !== rule.id);
      saveConfig(); saveState(); renderPanel();
    });
    header.appendChild(descInput);
    header.appendChild(delBtn);
    wrap.appendChild(header);

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
    topicField.appendChild(el('span', { text: '≥' }));
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
    for (const [val, label] of [['swapImage', 'Swap image'], ['popup', 'Show popup'], ['runScript', 'Run script']]) {
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
      else rule.action = { type, code: rule.action.code || '// ctx.$(sel) -> element\n// e.g. ctx.$("h1").textContent = "Personalised!";' };
      saveConfig(); renderPanel();
    });
    actField.appendChild(actSel);
    wrap.appendChild(actField);

    // Action-specific fields
    if (rule.action.type === 'swapImage') {
      const selField = el('div', { className: 'pp-thr-field' });
      selField.appendChild(el('label', { text: 'Target' }));
      const selInput = el('input', { type: 'text', value: rule.action.selector || '', placeholder: '.hero, #banner, img.foo' });
      selInput.addEventListener('change', () => { rule.action.selector = selInput.value; saveConfig(); });
      const pickBtn = el('button', { className: 'pp-btn pp-btn--sm', text: 'Pick' });
      pickBtn.title = 'Click an element on the page to capture its selector';
      pickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startPick((sel) => { rule.action.selector = sel; saveConfig(); renderPanel(); });
      });
      selField.appendChild(selInput);
      selField.appendChild(pickBtn);
      wrap.appendChild(selField);

      const imgField = el('div', { className: 'pp-thr-field' });
      imgField.appendChild(el('label', { text: 'Image URL' }));
      const imgInput = el('input', { type: 'text', value: rule.action.image || '', placeholder: 'https://…' });
      imgInput.addEventListener('change', () => { rule.action.image = imgInput.value; saveConfig(); });
      imgField.appendChild(imgInput);
      wrap.appendChild(imgField);
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
      const ctaHrefInput = el('input', { type: 'text', value: (rule.action.cta || {}).href || '', placeholder: 'https://…' });
      ctaHrefInput.addEventListener('change', () => {
        rule.action.cta = rule.action.cta || {}; rule.action.cta.href = ctaHrefInput.value;
        if (!ctaHrefInput.value && !(rule.action.cta.label)) rule.action.cta = null;
        saveConfig();
      });
      ctaHrefField.appendChild(ctaHrefInput);
      wrap.appendChild(ctaHrefField);
    } else if (rule.action.type === 'runScript') {
      const codeField = el('div');
      const codeLabel = el('div', { className: 'pp-rule-meta', text: 'JS runs with `rule` and `ctx` in scope. Helpers: ctx.$(sel), ctx.$$(sel), ctx.state, ctx.log(…).' });
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
      if (!ok) alert('Rule ran but returned no effect — check selector / URL / console.');
    });
    const unfireBtn = el('button', { className: 'pp-btn pp-btn--sm', text: fired ? 'Un-fire' : 'Not fired' });
    if (!fired) unfireBtn.disabled = true, unfireBtn.style.opacity = 0.5;
    unfireBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.firedRules = state.firedRules.filter(id => id !== rule.id);
      saveState(); renderPanel();
    });
    rowActions.appendChild(testBtn);
    rowActions.appendChild(unfireBtn);
    wrap.appendChild(rowActions);

    return wrap;
  }

  // -------------------- Config view --------------------
  function renderConfig(body) {
    // AI author — first thing in Config so it's discoverable
    body.appendChild(el('h4', { text: 'AI author' }));
    const aiBtn = el('button', { className: 'pp-btn pp-btn--full', text: '✨ Generate config with AI' });
    aiBtn.addEventListener('click', (e) => { e.stopPropagation(); openAiPromptModal(); });
    body.appendChild(aiBtn);
    body.appendChild(el('div', { className: 'pp-hint', text: 'Copy a prompt for ChatGPT/Claude, paste back JSON to import.' }));

    // Topics
    body.appendChild(el('h4', { text: 'Topics' }));
    const topicList = el('ul');
    if (!config.topics.length) topicList.appendChild(el('li', { className: 'pp-empty', text: 'No topics — add one below' }));
    else {
      for (const t of config.topics) {
        const li = el('li');
        const input = el('input', { className: 'pp-topic-edit', type: 'text', value: t.label });
        input.addEventListener('change', () => { t.label = input.value.trim() || t.id; saveConfig(); renderPanel(); });
        const del = el('button', { className: 'pp-icon', text: '×', ariaLabel: 'Delete topic', title: 'Delete topic' });
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
    const newTopicInput = el('input', { type: 'text', placeholder: 'New topic name…' });
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
        meta.appendChild(document.createTextNode(' → '));
        meta.appendChild(topicSel);
        meta.appendChild(document.createTextNode(' × '));
        meta.appendChild(wInput);
        rbody.appendChild(patInput);
        rbody.appendChild(meta);
        li.appendChild(rbody);
        const del = el('button', { className: 'pp-icon', text: '×', ariaLabel: 'Delete rule', title: 'Delete rule' });
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

    // Threshold rules — the "what happens when" configuration
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

    // Import / Export — real file operations
    body.appendChild(el('h4', { text: 'Save / load story' }));
    const ioRow = el('div', { className: 'pp-actions-row' });
    const exportBtn = el('button', { className: 'pp-btn', text: '⬇ Export' });
    const importBtn = el('button', { className: 'pp-btn', text: '⬆ Import' });
    ioRow.appendChild(exportBtn);
    ioRow.appendChild(importBtn);
    body.appendChild(ioRow);
    body.appendChild(el('div', { className: 'pp-hint', text: 'Exports a JSON file: web_perso_story__<site>__<date>.json' }));

    exportBtn.addEventListener('click', (e) => { e.stopPropagation(); exportStoryFile(); });
    importBtn.addEventListener('click', (e) => { e.stopPropagation(); openImportPicker(); });

    // Advanced fallback — kept behind a details toggle for copy-paste flows
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
      try { await navigator.clipboard.writeText(jsonArea.value); copyBtn.textContent = 'Copied ✓'; setTimeout(() => copyBtn.textContent = 'Copy', 1500); }
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

    const intent = userIntent && userIntent.trim()
      ? userIntent.trim()
      : '<< Describe what you want the personalisation to accomplish. Examples:\n'
        + '   - "Boost Sri Lanka interest — swap homepage hero and CTA copy for anyone who has viewed 3+ Sri Lanka pages."\n'
        + '   - "Highlight family holidays for repeat visitors who\'ve clicked family destinations."\n'
        + '   - "Nudge premium travel — show a popup with a concierge CTA after 5 luxury-tier page views." >>';

    return `You are helping author a JSON config for a client-side website
personalisation engine called Personalise (web_perso_story format).

TARGET SITE
Base URL: ${origin || '(unknown — user is running locally)'}
Hostname: ${host}
Example URLs to look at first:
${urlList}

WHAT I WANT (user intent)
${intent}

YOUR TASK
1. Crawl the target site starting from the example URLs above. Look at the
   real HTML — identify hero blocks, CTAs, navigation, section headings,
   and any content you'd want to personalise for the intent above.
2. Propose 2–5 topics that capture the segments the intent implies.
3. Propose urlRules that map URL patterns → topic weights so browsing the
   site accumulates topic scores naturally. Prefer prefix or regex rules
   that cover a section rather than an exact path per page.
4. Propose thresholdRules that swap images, show popups, or run scripts
   when a topic score meets its threshold. Only add rules that make sense
   for the intent — don't invent noise.
5. For each thresholdRule, include an appliesOn pattern so it doesn't fire
   on unrelated pages. Leave appliesOn empty only for site-wide effects.
6. Return ONE JSON object, no prose around it, matching the exact schema
   below. Do not wrap it in markdown code fences.

SCHEMA (must match exactly — engine imports this verbatim)
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
{ "type": "swapImage", "selector": "<CSS selector>", "image": "<absolute image URL>" }

Show popup:
{ "type": "popup",
  "title": "<string>",
  "body": "<string>",
  "cta": { "label": "<button text>", "href": "<url>" }   // optional
}

Run script (arbitrary DOM tweaks — use ONLY when swapImage/popup can't cover it):
{ "type": "runScript",
  "code": "<JS body. \`rule\` and \`ctx\` are in scope. Helpers:\n  ctx.$(sel) -> first element\n  ctx.$$(sel) -> all elements\n  ctx.state -> read-only scores/firedRules\n  ctx.log(...) -> console.info>"
}

AUTHORING RULES
- Topic IDs must be kebab-case (sri-lanka-interest, family-focused, etc.).
- Weights: 1 is the default per-page contribution. Use higher weights
  (2–3) for hub / landing pages and 4+ only for very high-signal pages.
- Prefer semantic CSS selectors (BEM-style: .brand-hero__title, .cta__button)
  over deep :nth-of-type() chains. If the site uses utility-class frameworks
  (Tailwind etc.), prefer data-* attributes or aria-label selectors.
- Only pick images you can verify are hotlink-safe — Wikimedia Commons,
  the site's own CDN, or open-license photo hosts. Never invent URLs.
- If runScript is unavoidable, keep the snippet short (<20 lines) and
  never touch localStorage / cookies / fetch / navigate.
- appliesOn should be tight. A homepage-hero swap should appliesOn the
  homepage only, not everywhere.
- Set _exportedAt to the current UTC timestamp in ISO 8601 format.

OUTPUT
Output ONLY the JSON object described above. No introduction, no
explanation, no code fences. The output must parse cleanly with JSON.parse.`;
  }

  function openAiPromptModal() {
    // Reuse popup-style modal
    if (document.getElementById('pp-ai-modal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'pp-ai-modal';
    const backdrop = document.createElement('div'); backdrop.className = 'pp-ai-backdrop';
    const box = document.createElement('div'); box.className = 'pp-ai-box';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pp-ai-close'; closeBtn.textContent = '×'; closeBtn.setAttribute('aria-label', 'Close');

    const title = document.createElement('h3'); title.textContent = 'AI-author a config';
    const sub = document.createElement('div'); sub.className = 'pp-ai-sub';
    sub.textContent = 'Describe what you want, copy the prompt into ChatGPT/Claude, then paste the JSON back.';

    const intentLabel = document.createElement('label'); intentLabel.textContent = 'What should the personalisation do?';
    intentLabel.className = 'pp-ai-label';
    const intentArea = document.createElement('textarea'); intentArea.className = 'pp-ai-intent'; intentArea.rows = 3;
    intentArea.placeholder = 'e.g. Boost Sri Lanka interest — swap the homepage hero and CTA for anyone who has viewed 3+ Sri Lanka pages.';

    const copyBtn = document.createElement('button'); copyBtn.className = 'pp-btn'; copyBtn.textContent = '📋 Copy prompt';
    const openBtn = document.createElement('button'); openBtn.className = 'pp-btn'; openBtn.textContent = 'Open ChatGPT →';
    openBtn.title = 'Opens chat.openai.com in a new tab';

    const rowA = document.createElement('div'); rowA.className = 'pp-ai-row';
    rowA.appendChild(copyBtn); rowA.appendChild(openBtn);

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
    box.appendChild(outLabel);
    box.appendChild(outArea);
    box.appendChild(rowB);
    wrap.appendChild(backdrop);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    function close() { wrap.remove(); }
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);

    copyBtn.addEventListener('click', async () => {
      const prompt = buildAiPrompt(intentArea.value);
      try {
        await navigator.clipboard.writeText(prompt);
        copyBtn.textContent = 'Copied ✓';
        setTimeout(() => copyBtn.textContent = '📋 Copy prompt', 1500);
      } catch (err) {
        // Fallback: fill outArea so user can copy manually
        outArea.value = prompt; outArea.focus(); outArea.select();
        alert('Clipboard blocked — prompt placed in the response box. Copy from there.');
      }
    });

    openBtn.addEventListener('click', () => {
      window.open('https://chat.openai.com/', '_blank', 'noopener');
    });

    applyBtn.addEventListener('click', () => {
      const raw = outArea.value.trim();
      if (!raw) { alert('Paste the AI\'s JSON output first.'); return; }
      let parsed;
      try {
        // Tolerate the model wrapping in code fences even though we asked not to
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
        parsed = JSON.parse(cleaned);
      } catch (err) { alert('Not valid JSON: ' + err.message); return; }
      try {
        const cfg = parsed && parsed._kind === 'web_perso_story' && parsed.config ? parsed.config : parsed;
        applyImportedConfig(cfg);
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
      // Pre-apply CSS overrides immediately — happens synchronously in the
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
    if (!rule.action.selector || !rule.action.image) return false;
    if (!ruleApplies(rule)) return false;
    const score = state.scores[rule.topicId] || 0;
    // Pre-apply if score is already ≥ threshold OR the rule has already fired
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
      const sel = rule.action.selector;
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

    // 3. Preload links (idempotent — dedupe by href)
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
                    // background-image element — CSS already handles it, but set
                    // inline as a belt-and-braces guard.
                    el.style.backgroundImage = `url('${img}')`;
                  }
                }
              } catch (e) { /* invalid selector — ignore */ }
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
      if (rule.action.type !== 'swapImage') continue;
      if (!state.firedRules.includes(rule.id)) continue;
      if (!ruleApplies(rule)) continue;
      actions.swapImage(rule);
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
    //    background/img — that's fine, it's the same value.
    evaluateRules();
    // 4. Re-run pre-apply so newly-fired rules get their CSS/preload/observer
    //    in place for any SPA route changes coming next.
    preApplyPaintedRules();
    renderPanel();
    installNavigationHooks();
    console.info('[personalise] engine ready', { client: config.client, mode: ui.mode, state });
  }

  // Run pre-apply as EARLY as possible — even before DOMContentLoaded.
  // This is what stops the flicker for background-image swaps: the CSS lands
  // before the browser has painted the target element.
  preApplyPaintedRules();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
