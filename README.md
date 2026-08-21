# Personalise

A client-side website personalization engine that runs from your bookmarks bar. Tag pages while you browse, configure rules that swap heroes, show popups, or run scripts when a topic score crosses a threshold.

## What's here

- **`personalise.js`** — the engine. Vanilla JS, no build step. Injects itself into any page.
- **`install.html` + `install.js`** — landing page that generates two bookmarklet variants (loader + inline) and offers a copy-to-clipboard DevTools fallback.
- **`index.html`, `sri-lanka.html`, `styles.css`, `home.css`, `home.js`** — a local Audley Travel lookalike used to demo the engine.

## How the engine works

Two modes toggled from the floating panel:

- **Runtime** — scores the current URL against saved `urlRules`, accumulates topic scores in `localStorage`, and fires `thresholdRules` when a score meets the threshold.
- **Config** — manage topics, tag any page with a topic + weight while you browse, edit URL rules inline (exact/prefix/regex), and build threshold rules with three action types:
  - `swapImage` — swap an `<img src>` or a `background-image`
  - `popup` — modal with optional CTA
  - `runScript` — arbitrary JS with `rule` and `ctx` in scope (`ctx.$`, `ctx.$$`, `ctx.state`, `ctx.log`)

**Zero-flicker image swaps:** on boot, before body renders, the engine injects a `<style>` block that pre-applies `background-image` for already-fired rules, adds `<link rel="preload">` for the swap images, and installs a `MutationObserver` to rewrite `<img src>` before first paint.

**SPA-aware:** patches `history.pushState`/`replaceState`, listens for `popstate`, re-scores and re-fires rules on route changes.

## Publishing to GitHub Pages

Push this whole directory to GitHub and enable Pages. Both bookmarklets will then work from `https://{rimantas757}.github.io/{web_perso_sim}/install.html`.

```bash
# From this directory:
git init
git add personalise.js install.html install.js README.md
# (Optional demo files — only push if you want the lookalike site online:)
# git add index.html sri-lanka.html styles.css home.css home.js
git commit -m "Personalise engine + installer"

# Create the repo on github.com first, then:
git branch -M main
git remote add origin https://github.com/rimantas757/web_perso_sim.git
git push -u origin main
```

Then on GitHub:

1. Repo → Settings → **Pages**
2. **Source**: Deploy from a branch
3. **Branch**: `main` / `/root`
4. Save. Wait ~30 seconds.
5. Visit `https://rimantas757.github.io/web_perso_sim/install.html`.

Update the footer link in [install.html](install.html) (`id="repo-link"`) once you have the GitHub URL.

## Iterating

- Edit `personalise.js` locally, push. The **loader bookmarklet** fetches the latest version on every click (cache-busted). Users don't need to re-drag.
- The **inline bookmarklet** carries the engine in the URL, so it's frozen at the moment the user dragged it. To pick up new features they visit `/install.html` again and re-drag.

## Storage layout

Everything lives in `localStorage` under the *target site's* origin (so per-site isolation is automatic):

- `personalise::config` — topics, urlRules, thresholdRules
- `personalise::state` — scores, firedRules, scoredUrls
- `personalise::ui` — panel mode, collapsed state

Configs are portable: **Config mode → Import / Export JSON** copies the whole thing to clipboard or pastes one in.
