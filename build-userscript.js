#!/usr/bin/env node
/* Build personalise.user.js from personalise.js + a Tampermonkey metadata
 * block. Run this after every edit to personalise.js so the userscript stays
 * in sync. Tampermonkey then picks up the new version on the daily check
 * (or immediately when the user hits "Check for updates").
 *
 * Usage:  node build-userscript.js
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const engineFile = path.join(root, 'personalise.js');
const outFile = path.join(root, 'personalise.user.js');

const engine = fs.readFileSync(engineFile, 'utf8');

// Bump patch on every build so Tampermonkey's version comparator triggers
// an update. We embed the timestamp in the version — YYYY.MM.DD.HHmm.
const d = new Date();
const pad = n => String(n).padStart(2, '0');
const version = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}.${pad(d.getHours())}${pad(d.getMinutes())}`;

const base = 'https://rimantas757.github.io/web_perso_sim';

const meta = `// ==UserScript==
// @name         Personalise (rimantas757/web_perso_sim)
// @namespace    ${base}
// @version      ${version}
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
// @updateURL    ${base}/personalise.user.js
// @downloadURL  ${base}/personalise.user.js
// @supportURL   https://github.com/rimantas757/web_perso_sim/issues
// @homepageURL  https://github.com/rimantas757/web_perso_sim
// ==/UserScript==

`;

fs.writeFileSync(outFile, meta + engine);
console.log(`Wrote ${outFile}`);
console.log(`Version: ${version}`);
console.log(`Size:    ${(fs.statSync(outFile).size / 1024).toFixed(1)} KB`);
