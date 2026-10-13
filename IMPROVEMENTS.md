# Making Personalise code-free for the SE

**Goal:** let a Salesforce SE build dynamic banners, product recommendations, and
pop-ups during a live demo without typing a CSS selector, an image URL, or a line
of JavaScript — and without fumbling.

**Audience:** the SE/seller driving the demo (not the prospect's marketer). They
understand personalization concepts; they should never have to *author code* to
show them. Fast and fumble-proof beats powerful-but-fiddly.

**Constraint:** inline LLM calls from the panel are acceptable (API key or small
proxy), so "describe it → rules appear" is on the table alongside no-AI paths.

---

## Where the friction is today

The engine (`personalise.js`) has exactly three action types — `swapImage`,
`popup`, `runScript` — authored three ways:

| Path | File ref | Problem for a live demo |
|------|----------|-------------------------|
| Manual panel editing | `renderThresholdRule` (personalise.js:1043) | Still asks for a **CSS selector** (personalise.js:1164) and an **image URL** (personalise.js:1178). Easy to typo, easy to get a selector wrong on an unfamiliar prospect site. |
| `runScript` | personalise.js:1218 | Raw JS. Banners and product recs currently *only* exist as hand-written script. Not demo-safe. |
| AI author | `buildAiPrompt` (personalise.js:1521) | Copy a long prompt → paste into ChatGPT → download JSON → import. A multi-step round trip, and selector quality depends on the LLM guessing from crawled HTML. |

The common failure mode: **every non-trivial action bottoms out in a selector, a
URL, or JSON.** That's the thing to design away.

There's also a **missing primitive**: there is no product-recommendations action
at all. For a personalization demo that's the single most-expected pattern, and
today it would have to be built in `runScript`.

The one genuinely code-free tool that already exists is the element **picker**
(`startPick`, personalise.js:545) — click an element on the page, capture its
selector. It's wired only to `swapImage`'s target field today. It should become
the backbone of every action.

---

## Recommendations, ranked

### 1. Make the picker the universal input (foundational)
Everything below depends on this. Extend `startPick` so any action that needs a
DOM location gets it by clicking the page, never by typing a selector:
- swapImage target (already done)
- banner insertion point (new)
- product-rec container (new)
- popup anchor, if we want positioned popups

The SE's mental model becomes "click where it goes," not "describe where it goes."

### 2. Promote **Banner** to a first-class action type
Today a banner = `runScript`. Make it `insertBanner` with a simple form:
message, CTA text, CTA link, position (top / bottom / after-picked-element),
color. The engine inserts and styles it; the SE types words, not code. This is
the lowest-effort item that directly removes code from one of the three named
asks.

### 3. Add a **Product recommendations** action type
New `productRecs` action: pick a container by clicking, then add 2–4 cards, each
`{ image, title, price, link }`. Images come from the library (see #5), not URLs.
This fills the glaring gap — the most-requested personalization pattern — with
zero code.

### 4. Ship a **template / recipe library** (biggest demo-speed win, no AI)
A dropdown of pre-built "stories" that seed topics + URL rules + threshold rules
in one click:
- "Boost destination X" (hero swap + CTA)
- "Repeat-visitor welcome banner"
- "Cart-abandon pop-up"
- "You might also like… (product recs)"

Covers ~80% of demos with zero typing and zero AI latency. Builds on the existing
import path (`applyImportedConfig`) — a recipe is just a bundled config object.
Parameterize the one or two variables (destination name, product set) with
click-to-fill chips.

### 5. Replace image **URL fields** with an image library + drop-to-data-URL
The URL field (personalise.js:1178) is a quiet demo-killer: hotlink-safety,
finding a URL, pasting it right. Mirror the existing `PERSONA_LIBRARY`
(personalise.js:51) pattern with a curated image set, plus drag-and-drop that
converts a local file to a data URL. No URL typing.

### 6. Inline AI (the "wow", now unblocked)
Since inline LLM calls are acceptable, collapse the copy-paste round trip into
one panel action: SE types intent → engine calls the LLM with the existing
`buildAiPrompt` schema → rules appear and apply live. Keep the current
copy-paste flow as the no-key fallback.
- **Decision needed:** API key stored locally in the panel vs. a tiny hosted
  proxy (keeps the key off the SE's machine, enables logging/guardrails).
- **Risk to manage:** latency and selector accuracy on a live stage. Mitigate by
  having AI *propose* rules into the editor (reviewable) rather than firing them
  blind, and by letting the SE re-pick any selector the AI got wrong with the
  picker from #1.

### 7. Reframe the editor as a plain-language sentence (polish)
The data model already reads like a sentence: "When *topic* ≥ *N* on *page*, do
*action*." Lean into it — each blank a click-to-fill chip rather than a form
field. Lower priority; it's ergonomics on top of 1–6.

---

## Suggested sequencing

1. **Universal picker** (#1) — unblocks the rest.
2. **Banner** + **Product recs** action types (#2, #3) — the two missing code-free primitives among the three named asks.
3. **Image library** (#5) — removes the last typed field from those actions.
4. **Template library** (#4) — fastest standalone demo-speed win; can land in parallel.
5. **Inline AI** (#6) — highest wow, most moving parts; do it once 1–5 make the output easy to review and fix.

Net effect: dynamic banners, product recs, and pop-ups all become
pick-and-fill-a-form operations, with AI as a one-click accelerator on top —
no selectors, no URLs, no JavaScript in the SE's hands.
