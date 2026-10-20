# TODO

Local issue tracker for **Zen Tint**. Plain markdown, no external service —
edit it in place, one entry per issue, keep IDs stable and never reuse them.

- **Scope:** issues and work items for this repo only (`tint.uc.js`, `frame.js`,
  `style.css`, the manifest, docs).
- **Not for:** Zen/Sine upstream bugs, or Gecko platform bugs (link them, don't
  own them).
- **Conventions:** see [Adding an entry](#adding-an-entry). Read `AGENTS.md` for
  the invariants a fix has to respect — several open items below touch the
  sampling path, which is performance-sensitive.
- **History:** the previous tracker (`ZPT-001`…`ZPT-009`, plus the `ZPT-D001`…
  `D003` Done log) is preserved verbatim in [`TODO-archive.md`](TODO-archive.md).
  IDs are never reused, so this file starts at **ZPT-010**.

## Current focus: page-background tint source

Today the sampler prefers the *painted pixels* (`drawWindow` of the central 60%)
over the page's *declared* background. That is what makes the frame follow a
video and rescue dark apps that lie about their background — but it also means
the chrome is tinted by "whatever the visible content averages to", not by the
page's own background. This work adds a second source that tints the chrome with
the **page's declared background color** so the frame reads as a continuation of
the page — and makes it the default.

Decisions taken (do not relitigate without reason):

| Decision | Choice | Consequence |
|---|---|---|
| Which surfaces | **All chrome surfaces** | No `style.css` change — the source feeds the one tint variable every surface already consumes. |
| Default | **`page-background`** | The frame follows the page's declared background out of the box; the pixel sampler stays one click away in the panel. |
| Transparent `body`/`html` | **Clear the tint → Zen theme** | Predictable, but see [ZPT-014](#zpt-014) (wrapper backgrounds get no tint). |
| Pref lifecycle | **Live (no restart)** | Same treatment as `youtube-ambient` / `light-average`: clear cache + force resample. |

## Status legend

| Status | Meaning |
|---|---|
| `open` | Confirmed, not started. |
| `wip` | Actively being worked. |
| `blocked` | Waiting on something (upstream, repro, decision). |
| `accepted` | Known and deliberately not fixed; recorded so it isn't re-reported. |
| `done` | Fixed. Keep the entry; move it to the [Done log](#done-log). |

## Index

| ID | Status | Sev | Area | Title |
|---|---|---|---|---|
| [ZPT-010](#zpt-010) | done | med | tint.uc.js | `color-source` pref (`content` \| `page-background`) + config plumbing |
| [ZPT-011](#zpt-011) | done | med | frame.js | `readDeclaredBackground()`: body → html → clear |
| [ZPT-012](#zpt-012) | done | low | manifest / docs | Dropdown entry, README + AGENTS updates, version bump |
| [ZPT-013](#zpt-013) | done | med | — | Verification checklist for the page-background source |
| [ZPT-014](#zpt-014) | accepted | low | frame.js | Sites whose background is on a wrapper get no tint |
| [ZPT-015](#zpt-015) | open | med | frame.js | Gmail: the declared background is not the visible surface |
| [ZPT-016](#zpt-016) | open | low | frame.js | WhatsApp: partial mismatch |
| [ZPT-017](#zpt-017) | done | low | style.css | Frame separator: a hairline so the page stays bounded |
| [ZPT-018](#zpt-018) | open | med | tint.uc.js | No per-site color-source override |

---

## Open / tracked items

### ZPT-010
**`color-source` pref (`content` | `page-background`) + config plumbing**
- **Status:** done · **Sev:** med · **Area:** tint.uc.js (prefs, config, observer)
- **Goal:** add `zen.page-tint.color-source` (string, default `page-background`;
  values `page-background` = the declared background, `content` = today's chain).
- **Why this shape:** the source is a *content-process* decision, so it has to
  travel to `frame.js` in the config message. This is exactly the existing
  `youtube-ambient` / `light-average` pattern — no new mechanism.
- **Fix sketch:**
  - Read via the `prefStr` helper (own `try` — see the shared-`try` invariant).
  - Coerce anything that isn't a known value back to the default, so a typo in
    `about:config` can't select a half-implemented mode.
  - Add `colorSource` to the `sendConfig()` payload.
  - Add a `zen.page-tint.color-source` case to the branch observer: re-read,
    `themeCache.clear()`, `scheduleSample(true)` — identical to the
    `youtube-ambient` / `light-average` cases. The cache stores the *result*, not
    the pixels, so a source change invalidates every entry.
- **Restart vs live:** **live.** Belongs in the "Color source — applies live"
  bucket in `preferences.json`, not the restart group.
- **Refs:** `tint.uc.js` `sendConfig()`, the `youtube-ambient` observer case,
  `TODO-archive.md` #ZPT-D002 (why cache-shape changes clear + resample).
- **Blocks:** [ZPT-011](#zpt-011).

### ZPT-011
**`readDeclaredBackground()`: body → html → clear**
- **Status:** done · **Sev:** med · **Area:** frame.js (sampling)
- **Goal:** when `config.colorSource === 'page-background'`, return the page's
  *declared* background instead of the painted average.
- **Definition (chosen):** `body` computed `background-color` → `html` computed
  `background-color` → **null** (which makes the chrome clear the tint and fall
  back to Zen's theme). **No** DOM walk, **no** `drawWindow`, **no**
  `<meta name="theme-color">` on this path.
- **Fix sketch:**
  - New `readDeclaredBackground(doc)` reusing `normalizeColor()` so hex / HSL /
    named all normalize to canonical `rgb(r, g, b)`. A transparent
    (`rgba(…, 0)`) resolved value returns `null`, which is what cascades to the
    `html` fallback and then to "clear".
  - Short-circuit at the top of `read()`: branch to this and skip the existing
    chain (yt-ambient → pixel → meta → body/html → walk) entirely.
  - `source` string: `page-bg:body` / `page-bg:html` so debug logs and the
    `source` field stay diagnosable.
  - `edges: null` — a single declared color has no spatial content, so the
    ambient gradient is inert (same as today's `meta` / `body` / `html` paths).
    `zen-page-tint-ambient` is simply never set, so the gradient rules cost
    nothing.
- **Defaults to update:** add `colorSource: 'page-background'` to the
  `singleton.config` default object and copy it in `applyConfig()`, so a dropped
  config message leaves the default behavior in effect.
- **Interaction:** `ambient-spread` has no visible effect under this source —
  mention in the pref label / README ([ZPT-012](#zpt-012)), don't silently drop
  the pref.
- **Refs:** `frame.js` `read()`, `normalizeColor()`, `singleton.config`,
  `applyConfig`.
- **Depends on:** [ZPT-010](#zpt-010).

### ZPT-012
**Dropdown entry, README + AGENTS updates, version bump**
- **Status:** done · **Sev:** low · **Area:** manifest / docs
- **Items:**
  - `preferences.json`: a `"type": "dropdown"` in the "Color source — applies
    live" section — `page-background` ("The page's background — flat, blends
    in", the default) vs `content` ("The visible color — video-aware, follows
    content"). Confirmed supported by Zen's preferences schema (`options:
    [{label, value}]`).
  - `README.md`: add the pref to the live-applies table; lead with the
    page-background source as the idea and keep the pixel sampler as the opt-in
    alternative; note that `page-background` disables YouTube ambient mode,
    video-following, and `meta theme-color` preference, and that `ambient-spread`
    does nothing under it. Add the wrapper-background limitation
    ([ZPT-014](#zpt-014)) to Known limitations.
  - `AGENTS.md`: extend the "Sample chain" description with the second source,
    and put `color-source` in the live-applicable bucket under "Restart vs live
    prefs".
  - Version bump in **both** places (`theme.json` `version` and the
    `// @version` header in `tint.uc.js`) — see archived `ZPT-006`.
- **Refs:** `theme.json`, `tint.uc.js` header, `README.md`,
  `AGENTS.md`.

### ZPT-013
**Verification checklist for the page-background source**
- **Status:** done · **Sev:** med · **Area:** — (testing)
- **Why:** no automated harness; the interesting surface is a live Zen window.
  Perf is the product, so this needs a measurement, not a vibe check.
- **Checklist (set `zen.page-tint.debug = true`):**
  1. A site that declares `body` bg (light): chrome matches, text readable.
  2. The same site in dark scheme: chrome matches the dark declared bg.
  3. **GitHub** — declared bg vs visible page differ (see README); confirm which
     color lands and that it's the *declared* one.
  4. **Gmail** (dark mode lies about its background): confirm the known-wrong
     result is the *expected* wrong, and is reversible via the pref.
  5. **YouTube** — expect flat `#0f0f0f`, no ambient follow; confirm the toggle
     to `content` restores ambient.
  6. A **transparent body/html** page (SPA): expect the tint to clear to Zen's
     theme (the chosen fallback), not white.
  7. Toggle the pref from the settings panel **without a restart** — chrome
     should re-evaluate immediately.
  8. Tab-switch latency at the usual high tab count, before vs after, with the
     source on `page-background`.
- **Result (v1.0.0, manual pass in Zen):**
  1. ✅ **GitHub** — exact match.
  2. ✅ **Reddit** — exact match.
  3. ✅ **YouTube** — flat `#0f0f0f`, no ambient follow. Expected: the ambient
     path belongs to the `content` source only.
  4. ⚠️ **Gmail** — the frame does not match the visible app. See
     [ZPT-015](#zpt-015); diagnosis still open.
  5. ⚠️ **WhatsApp** — partial mismatch. See [ZPT-016](#zpt-016).
  6. ⬜ Not exercised — no transparent-body SPA in the pass.
  7. ⬜ Not reported.
  8. ⬜ Not measured. The declared source is *cheaper* than the pixel path (two
     computed styles vs a compositor readback), so no regression is expected —
     but it is still an expectation, not a measurement.
- **Refs:** `AGENTS.md` manual checklist; archived `ZPT-007`.

### ZPT-014
**Sites whose background is on a wrapper get no tint**
- **Status:** accepted · **Sev:** low · **Area:** frame.js (`html` source)
- **Symptom:** with `color-source = page-background`, a page that sets its color
  on a wrapper `<div>` rather than on `body`/`html` resolves to `null`, so the
  chrome shows Zen's theme instead of the page color — the opposite of "blend
  in". Common in SPAs.
- **Why:** the fallback was deliberately chosen as "clear to Zen theme"
  (interview decision) rather than walking the DOM to the nearest solid
  ancestor. This is now the **default** path, so it is the limitation most
  users will meet first — it is documented in the README's Known limitations.
- **Options:** the existing step-5 walk (nearest solid bg behind screen-center)
  would cover most of these. It is a one-line addition, but it re-introduces the
  "which element counts" ambiguity this source was meant to remove.
- **Revisit when:** it's reported more than once, or a major site is affected.
- **Workaround:** set `color-source` back to `content` for those sites, or
  add the host to `disable-hosts`.
- **Refs:** the interview decision recorded in [Current focus](#current-focus-page-background-tint-source).

### ZPT-015
**Gmail: the declared background is not the visible surface**
- **Status:** open · **Sev:** med · **Area:** frame.js (`readDeclaredBackground`)
- **Symptom:** on Gmail the chrome does not match what the eye is drawn to. The
  mail list is a white card sitting on a tinted app shell, and the frame lands
  on the shell.
- **Why:** Gmail's `<body>` declares the *app* background (the shell behind the
  card), not the card. Under the declared-background source that is the correct
  answer to the question being asked — and the wrong answer to "what color does
  this page look like". This is the documented trade-off, not a bug in the
  sampler.
- **Diagnosis still open:** the screenshot shows a slate-blue band over Gmail's
  header. That band may be Gmail's own transparent-header area showing the
  browser canvas through it, rather than anything the mod painted. Settle it
  with the computed value: open devtools on the Gmail tab, Console,
  `getComputedStyle(document.body).backgroundColor` — and compare it with the
  `[zen-tint] message received` log line.
- **Options:** a per-site source override (a host list that forces `content`
  for named hosts) — the clean fix, and the missing half of the "global, not
  per-site" limitation in the README. Or: accept it, since Gmail is precisely
  the case the `content` source exists for.
- **Workaround:** `zen.page-tint.disable-hosts` for `mail.google.com`, or
  switch the source back to `content`.
- **Refs:** [ZPT-014](#zpt-014), [ZPT-016](#zpt-016), the README's
  "global, not per-site" limitation.

### ZPT-016
**WhatsApp: partial mismatch**
- **Status:** open · **Sev:** low · **Area:** frame.js (`readDeclaredBackground`)
- **Symptom:** on WhatsApp Web the chrome does not match the page.
- **Why (probable):** WhatsApp Web paints its background on a wrapper element
  rather than on `<body>`, so the declared-background source either resolves to
  nothing or to a layer the user isn't looking at — the same class as
  [ZPT-014](#zpt-014). Not confirmed; needs the same computed-value check as
  [ZPT-015](#zpt-015).
- **Options:** see [ZPT-014](#zpt-014)'s options. A per-site source override
  would cover this one too.
- **Workaround:** `zen.page-tint.disable-hosts` for `web.whatsapp.com`.
- **Refs:** [ZPT-014](#zpt-014), [ZPT-015](#zpt-015).

### ZPT-017
**Frame separator: a hairline so the page stays bounded**
- **Status:** done · **Sev:** low · **Area:** style.css (+ prefs)
- **Why:** the point of the tint is continuity, but continuity taken too far
  erases where the page ends — a sidebar and a page in the same color read as
  one flat field. Requested after the v1.0.0 manual pass.
- **Fix:** `zen.page-tint.frame-separator` (int px, default 1) →
  `--zpt-frame-separator-width`. Drawn OUTSET in the frame gap (as the
  first-listed box-shadow, so it paints over the gap ring) in non-compact mode,
  and as an inset outline in compact mode, where there is no gap to draw in.
  The color is derived in CSS from `--zen-tab-header-foreground`, so it flips
  light/dark with the page and needs no knob of its own.
- **Invariant added:** the separator is drawn in the gap, never over the page's
  own pixels — see `AGENTS.md`.
- **Done in:** ZPT-D007.

### ZPT-018
**No per-site color-source override**
- **Status:** open · **Sev:** med · **Area:** tint.uc.js (prefs + config)
- **Symptom:** `zen.page-tint.color-source` is global. A user who prefers the
  declared background has no way to get the pixel path for the handful of sites
  that need it (Gmail, WhatsApp, any app that paints its background on a
  wrapper). The only escape today is `disable-hosts`, which turns the tint off
  entirely rather than switching source.
- **Why:** the source is decided per browser and pushed in the config message,
  and `sendConfig()` ALREADY resolves a host list per URL — that's exactly how
  `live-mode-hosts` forces always-on polling (`alwaysOn: LIVE_ALWAYS_ON ||
  hostMatches(url, LIVE_HOSTS)`). So this is mostly a matter of resolving the
  source against a host list instead of globally; the plumbing is already there.
- **Options:**
  - `zen.page-tint.content-hosts` — a host list that forces `content` for named
    hosts (and optionally the inverse, `page-background-hosts`). Resolved in
    `sendConfig()` exactly like the live-mode allowlist.
  - Extend `disable-hosts` with a per-host mode instead of adding a list.
- **Blocks:** the clean fix for [ZPT-015](#zpt-015) and
  [ZPT-016](#zpt-016).
- **Refs:** [ZPT-014](#zpt-014), the README's "global, not per-site" limitation.

---

## Done log

Fixed items, newest first. Kept for reference so the numbers aren't reused.

_(nothing yet — this tracker starts at ZPT-010; earlier history is in
[`TODO-archive.md`](TODO-archive.md))_

### ZPT-D007
**Frame separator hairline** — `done`
- `zen.page-tint.frame-separator` (default 1px) → `--zpt-frame-separator-width`.
- Outset shadow in the frame gap (non-compact), inset outline (compact).
- Color derived from the tint's foreground, so it contrasts either way.
- Version `1.0.0` → `1.1.0` in `theme.json` **and** the `// @version` header.

### ZPT-D006
**Dropdown entry, README + AGENTS updates, version bump** — `done`
- `preferences.json`: dropdown in the live "Color source" section, default
  `page-background`.
- `README.md` rewritten around the declared-background idea; the pixel sampler
  is documented as the opt-in alternative.
- `AGENTS.md`: second source described; new invariant for config changes.
- Version `2.0.0` → `1.0.0` in `theme.json` **and** the `// @version` header.

### ZPT-D005
**`readDeclaredBackground()`: body → html → clear** — `done`
- New sampler in `frame.js`, short-circuiting the pixel chain entirely under
  the `page-background` source.
- `source` strings `page-bg:body` / `page-bg:html` / `page-bg:none`.
- `edges: null` — no gradient under this source.
- **Beyond the original sketch:** a config change that alters what a sample
  yields now re-samples in the frame. Without it the new source only took
  effect on the next mutation / poll tick / tab switch — on a static page with
  no video, none of those may ever happen.

### ZPT-D004
**`color-source` pref + config plumbing** — `done`
- `zen.page-tint.color-source`, default `page-background`, unknown values
  coerced back to the default.
- Pushed to the frame script in the config message; live-applied through the
  `zen.page-tint.` pref observer (clear cache + force resample).

---

## Adding an entry

Copy this block, give it the next free `ZPT-NNN`, and add a row to the
[Index](#index):

```markdown
### ZPT-NNN
**Short title**
- **Status:** open · **Sev:** low|med|high · **Area:** file-or-subsystem
- **Symptom:** what the user actually sees, or what breaks.
- **Why:** the mechanism. Name the function/selector when you know it.
- **Options / Fix sketch:** candidates considered, with the tradeoff of each.
- **Workaround:** what the user can do today, if anything.
- **Refs:** commit hashes, upstream links, related ZPT IDs.
```

Rules of thumb:

- **Derive entries from the code, not from imagination.** Every item here traces
  to a comment, a `KNOWN LIMITATION` in the README, or a real convention gap.
- **`accepted` is a valid outcome.** "Known, judged not worth fixing" is a
  decision — record the reasoning so the next person doesn't relitigate it.
- **Don't reopen `.tabbrowser-tab` transitions or per-pixel tint layering.**
  Those were diagnosed and fixed (see `AGENTS.md`); regressions there are bugs
  against a known invariant, not features.
- **Perf items need a measurement**, not a hunch. The product is tab-switch
  latency at high tab counts.
