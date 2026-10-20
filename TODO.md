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

## Current focus: one behaviour, one drawn boundary

The fork's thesis is **the frame continues the page's declared surface** — not
"the frame samples the page's pixels". Two things follow from taking that
seriously:

1. **One behaviour.** The pixel sampler and everything that only exists to
   serve it get deleted — the mod reads the page's declared background and
   nothing else. → [ZPT-021](#zpt-021)
2. **A drawn boundary.** Continuity taken too far erases where the page ends.
   The boundary becomes a deliberate thing: a squircle outline around the whole
   viewport, in the page's primary color. → [ZPT-019](#zpt-019)

And the previous repo's behaviours — the pixel sampler, the YouTube ambient
path, live-mode polling, the directional gradient, the source switch — go, so
the mod does exactly one thing: **match the page's declared background**.
→ [ZPT-021](#zpt-021)

**Order:** ZPT-019 (the visible result) is done, and so is ZPT-022 (the outline
is now a real switch in the settings). Next is ZPT-023 (take the outline's color
from the page's own visible colors instead of the favicon). ZPT-021 is the
cleanup that makes the mod one thing; it is not blocked by them, but it and
ZPT-023 touch the same code (the pixel sampler), so the two have to be
reconciled rather than landing in any order.

**One thing left open:** the upstream **inset frame** (gap + radius + drop
shadow — the "page as a floating card" look) is presentation, not matching, so
it stays for now. It matters only because it decides where ZPT-019's outline
is drawn: inside the tinted strip, or at the window edge.

Decisions taken (do not relitigate without reason):

| Decision | Choice | Consequence |
|---|---|---|
| Which surfaces | **All chrome surfaces** | No `style.css` change — the source feeds the one tint variable every surface already consumes. |
| Number of behaviours | **One** (declared background) | The `content` source is deleted, not deprecated — see [ZPT-021](#zpt-021). |
| Transparent `body`/`html` | **Clear the tint → Zen theme** | Predictable, but see [ZPT-014](#zpt-014) (wrapper backgrounds get no tint). |
| The page's edge | **A drawn outline** | The boundary is painted, in the site's primary color — see [ZPT-019](#zpt-019). The upstream inset frame stays for now (presentation, not matching). |
| Pref lifecycle | **Live (no restart)** | Same treatment as the CSS-variable prefs: clear cache + force resample. |

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
| [ZPT-018](#zpt-018) | accepted | med | tint.uc.js | No per-site color-source override |
| [ZPT-019](#zpt-019) | done | med | style.css + tint.uc.js | **Page outline: wrap the whole viewport as a squircle, in the site's primary color** (priority 1) |
| [ZPT-020](#zpt-020) | accepted | med | — | Keep only the page-background matching (merged into ZPT-021) |
| [ZPT-021](#zpt-021) | open | med | frame.js (bulk) | Keep only the page-background matching — delete everything else the previous repo did |
| [ZPT-022](#zpt-022) | done | low | tint.uc.js + preferences.json | **Page outline: make it optional — a real toggle in the settings** (priority 2) |
| [ZPT-023](#zpt-023) | open | med | frame.js + tint.uc.js | **Outline color: use the page's own visible colors instead of the favicon** (priority 3) |

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
- **Refs:** the interview decision recorded in [Current focus](#current-focus-one-behaviour-one-drawn-boundary).

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
- **Note:** [ZPT-021](#zpt-021) removes the `content` source, so this
  workaround disappears. The remaining answers are a better declared-background
  read, or an explicit "accepted" decision.
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
  would cover this one too — but [ZPT-021](#zpt-021) removes the second source,
  so that option goes away with it.
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
- **Superseded in part by [ZPT-019](#zpt-019):** as shipped, the hairline only
  renders on the three sides that have a gap — it is absent exactly at the
  sidebar edge, which is where it was wanted — and a flat 1px line cannot read
  as a squircle. The outline replaces it.

### ZPT-018
**No per-site color-source override**
- **Status:** accepted · **Sev:** med · **Area:** tint.uc.js (prefs + config)
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
- **Superseded by [ZPT-021](#zpt-021):** with one behaviour there is no second
  source to override, so a per-site source list has nothing to switch.

### ZPT-019
**Page outline: wrap the whole viewport as a squircle, in the site's primary color**
- **Status:** done · **Priority:** 1 · **Sev:** med · **Area:** style.css + tint.uc.js (chrome-side color extraction)
- **Goal:** the separator stops being a hairline hiding in the frame gap and
  becomes a deliberate frame drawn **around the whole page viewport** — all four
  sides, continuously, with squircle corners — painted in the **site's primary
  color** instead of a grey derived from the tint's foreground.
- **Why the v1.1.0 implementation misses the mark** (found in the manual pass):
  - It is drawn **outset, in the frame gap**, and the gap only exists on three
    sides: `#zen-appcontent-wrapper` has `margin: <gap> <gap> <gap> 0` — no gap
    on the left, because the sidebar is there. So the hairline renders on the
    top, right and bottom and **silently disappears on exactly the edge the
    user asked for**: the one against the sidebar.
  - It is a 1px flat line, so it cannot read as a squircle. The content
    container's radius is `0 0 <radius> <radius>` (flat top, rounded bottom),
    and an outset shadow follows the border box, not the page's shape.
  - Its color is `color-mix(--zen-tab-header-foreground 30%, transparent)` — a
    neutral grey/black/white derived from the tint's foreground. It reads as
    "a line someone drew", not as part of the page.
- **Where the primary color comes from: the site's favicon.**
  The technique is borrowed from
  [zen-tab-groups](https://github.com/oom333/zen-tab-groups) (MIT), which colors
  its section headers from the site icon:
  - **Icon candidates, in order:** the open tab's own `image` attribute (its
    favicon URL), then `page-icon:https://www.<site>/`, then
    `page-icon:https://<site>/`, then `https://<site>/favicon.ico`.
  - **Load** it into an `Image` in the **chrome** process, with a 5s timeout.
  - **Sample** it: draw to a 32×32 canvas with `imageSmoothingEnabled = false`
    (smoothing invents in-between shades while scaling), then read the pixels.
  - **Filter:** ignore pixels with alpha < 128; ignore near-black (L < 0.2) and
    white/grey (L > 0.85 or S < 0.25). If ≥ 75% of the opaque pixels were dark,
    or fewer than 8% were colorful, the icon has no usable color → no outline
    color at all.
  - **Pick:** count exact shades AND 12 hue families of 30°. Take the most
    common shade if it clearly leads (≥ 1.5× the runner-up and ≥ 25% of the
    colorful pixels); otherwise take the average of the biggest hue family,
    weighting the neighbouring families at 0.5 so a gradient crossing a family
    border isn't split in two.
  - **Clamp** for visibility: L into [0.45, 0.72], S ≥ 0.45.
- **Why the favicon, and not `<meta name="theme-color">` or a CSS custom
  property:**
  - It **is** the site's primary color — the brand mark, not a page's idea of
    one. A page's `theme-color` meta is often the background (GitHub's is
    `rgb(30,35,39)`), and a CSS variable scan has to guess at property names
    across every framework.
  - It is **per-site**, so it can be cached once per host and reused by every tab
    on that host, instead of per page.
  - It needs **no content process**: the chrome already has the tab, its favicon
    and the host. No new field in the theme message, no `frame.js` change, no
    change to the shape of the theme cache.
  - tab-groups already solved the hard parts: monochrome logos (→ no color), the
    grey placeholder icon Zen shows for unvisited sites (→ try the next
    candidate), and cross-origin tainting (`page-icon:` URLs are privileged and
    untainted; a tainted canvas throws in `getImageData` and must be caught).
  - **Caveats to design around:** the favicon is only known after the tab
    loads, so the outline color arrives a beat after the background tint; a
    monochrome or white logo yields no color; the color is per-site, so a
    multi-brand host (github.com vs gist.github.com) can be off.
  - **Licensing:** zen-tab-groups is MIT — reusing the algorithm means keeping
    its copyright notice and crediting it (README Credits section + LICENSE).
- **Fallback chain:** favicon color → the tint's own foreground (today's
  hairline) → no outline.
- **Definition (as shipped):**
  - **Where:** an overlay drawn **on** the page viewport's edge, over the
    content, on all four sides. It is a deliberate border (the way a
    reader-mode frame or a PDF viewer draws one), not a tint layer — see the
    invariant note below.
  - **Shape:** a squircle — continuous corners, not circular arcs. CSS
    `border-radius` produces circular arcs, which read as a different shape
    next to a superellipse. Firefox's `corner-shape: squircle` /
    `superellipse()` draws the real thing, so no SVG path is needed; the
    radius is a CSS knob (`--zpt-page-outline-radius`, 12px).
  - **Width:** `zen.page-tint.page-outline-width`, replacing
    `zen.page-tint.frame-separator`. Default 2px. `0` = off.
  - **Where the outline sits relative to the inset frame:** the upstream frame
    (gap/radius/shadow) stays, so the outline is drawn around the browser
    container — inside the tinted strip, on the page's own pixels. The open
    question from the original ticket is settled this way; see ZPT-021 for the
    cleanup that does not touch it.
- **Plumbing (all chrome-side, no IPC):**
  - `tint.uc.js`: an icon-color resolver — candidates, loader, `dominantColor()`,
    a per-site cache (`zen.page-tint.icon-colors`, a JSON pref like
    tab-groups'), and the "unsure sites" retry for placeholder icons.
  - The resolved color is written as `--zpt-page-site-color` on the root; the
    fallback chain (site color → the tint's foreground → nothing) lives in
    `style.css` as `--zpt-page-outline-color`.
  - The cache is per-SITE, so it does not disturb the existing per-URL theme
    cache (`{ bg, edges }`) — the outline color is looked up separately by host.
- **New invariant (written into `AGENTS.md`):** the outline is a
  deliberate 1–2px border drawn over the page's outermost pixels, so it IS a
  coat over content the mod doesn't own. That is allowed for a border and
  **forbidden for the tint overlay** — the tint must never cover the page.
  The two jobs must stay clearly separated: the tint lives on chrome surfaces,
  the outline lives on the page's edge, and neither may be used to do the
  other's job.
- **Also in this ticket:** the separator the user originally asked for — a
  line on the **sidebar's** content-facing edge — falls out of the same work,
  because a frame around the page touches that edge. **Decided: implied by the
  frame**, not a separate line — the outline's left edge IS that line.
- **Done in:** ZPT-D008.
- **Depends on:** nothing — the favicon color is independent of the color
  source, so this can land before or after [ZPT-021](#zpt-021).
- **Refs:** ZPT-D007 (the hairline this replaces),
  [zen-tab-groups](https://github.com/oom333/zen-tab-groups) (the icon-color
  technique), [ZPT-021](#zpt-021).

### ZPT-020
**Keep only the page-background matching (merged into ZPT-021)**
- **Status:** accepted · **Sev:** med · **Area:** frame.js / tint.uc.js / style.css
- **What this was:** written as *"remove the previous repo's inset frame (gap +
  radius + shadow)"*. The author meant something broader — **keep only the
  page-background matching, not whatever the previous repo was doing** — which is
  the same request as [ZPT-021](#zpt-021).
- **Merged into:** [ZPT-021](#zpt-021). The ID stays reserved; the work is
  tracked there.
- **What survives from the original idea:** the inset frame (gap + radius +
  shadow) is **presentation, not matching**, so it is not deleted by ZPT-021 by
  default — it stays unless the author says otherwise. It matters here only
  because it decides where [ZPT-019](#zpt-019)'s outline is drawn (inside the
  tinted strip, or at the window edge). That is now an explicit open question
  in both tickets.

### ZPT-021
**Keep only the page-background matching — delete everything else the previous repo did**
- **Status:** open · **Priority:** 2 · **Sev:** med · **Area:** frame.js (bulk), tint.uc.js, preferences.json, style.css, README, AGENTS.md
- **Goal:** ONE behaviour. The mod reads the page's **declared** background and
  tints the chrome with it. Everything the previous repo added **beyond** that
  — the painted-pixel sampler, the YouTube ambient path, live-mode polling, the
  directional gradient, the source switch — is deleted, not deprecated.
- **Why:**
  - The fork's thesis is "the frame continues the page's declared surface". A
    second, competing behaviour means the user has to decide which one they
    want (per install or per site), the README has to explain two
    philosophies, and every bug in the pixel path is still a bug in the mod.
  - One behaviour is also cheaper: the declared source is two computed styles
    instead of a compositor readback.
  - Less code to keep honest: `frame.js` should end up roughly a third of its
    current size.
- **What gets deleted (`frame.js`):**
  - `readPixel()` and the whole `reduceGrid` / `PIXEL_SAMPLE_*` machinery: the
    16×16 grid, the sRGB→linear LUT, `CHROMA_WEIGHT`, `EDGE_BAND`, the
    per-edge band accumulation.
  - `readYouTubeAmbient()` and the `#cinematics` / picture-box comment block.
  - The `<meta name="theme-color">` step, the DOM walk, and the body/html
    steps of the `content` chain (the declared source reads body/html
    directly, so those steps merge into it).
  - The live-mode poll loop, `significantChange()`, `checkVideoState()` and
    the video listeners — there is nothing to poll for: a declared background
    changes via CSS, which the mutation observers already catch.
  - The `edges` config field, `zen-page-tint-ambient`, the `--zpt-edge-*`
    variables, `edgeStop()`, `EDGE_ALPHA_MAX`, and the directional-gradient CSS.
- **What gets deleted (chrome side / config / UI):**
  - `zen.page-tint.color-source` and its dropdown (one value left is the one
    behaviour).
  - `zen.page-tint.youtube-ambient`, `zen.page-tint.light-average`,
    `zen.page-tint.ambient-spread`.
  - The live-mode group: `live-mode`, `live-mode-rate-ms`,
    `live-mode-threshold`, `live-mode-always-on`, `live-mode-hosts`. The
    **fade** (`live-mode-smoothing-ms`) is chrome-side and still wanted — it
    should be renamed to something honest (`zen.page-tint.fade-ms`) and moved
    out of the "restart" group if it can be made live (it is read once at
    load today).
  - The `YT_AMBIENT` / `LIGHT_AVERAGE` / `AMBIENT_SPREAD` module state, their
    observer cases, and `EDGE_ALPHA_MAX`.
- **What survives (and must be re-verified after the delete):**
  - The declared sampler (`readDeclaredBackground`), the cache, the rAF
    coalescing, the pref observer, the readable-foreground pick, the
    saturation / brightness / contrast / lightness adjustments, the strength
    overlay, the per-site disable list, and the new outline
    ([ZPT-019](#zpt-019)).
  - **OS `prefers-color-scheme` flips:** the chrome clears the cache and
    forces a resample, and the frame re-reads the computed style. With the
    poll loop gone this becomes the ONLY path for a page whose background
    follows the OS scheme, so the race between the page's own media-query
    re-evaluation and the forced resample has to be closed (a `matchMedia`
    change listener in the frame would cover it). **This is the one
    behavioural regression risk in the delete** and needs a manual test.
  - **Pages whose background changes without a DOM mutation** (a CSS animation
    on the background, a `:hover`-driven background): the mutation observer
    does not fire and the poll loop was what caught those. Under the declared
    source a poll is nearly free (two computed styles), so keeping a cheap
    poll may be worth more than deleting it. Decide explicitly — do not let
    the delete decide by accident.
- **Explicitly NOT in this ticket:** the upstream **inset frame** (gap + radius
  + shadow) is presentation, not matching — it stays unless the author says
  otherwise. It matters here only because it decides where
  [ZPT-019](#zpt-019)'s outline is drawn (inside the tinted strip, or at the
  window edge). [ZPT-020](#zpt-020) was this request, mis-phrased; it is merged
  here.
- **Knock-on effects:**
  - Archived ZPT-004 (`drawWindow` may be removed from Gecko) becomes moot —
    the only consumer of `drawWindow` is gone. Close it.
  - [ZPT-018](#zpt-018) (per-site source override) becomes moot — there is no
    second source to override. Close it.
  - Archived ZPT-009 (opposite-hue averaging to grey) is deleted along with
    the averaging. Close it.
  - [ZPT-015](#zpt-015) / [ZPT-016](#zpt-016) (Gmail, WhatsApp) lose their
    workaround — switching the source back to `content` stops existing. They
    stay open and need a different answer, or an explicit "accepted".
  - The README's "Two color sources", "Directional ambient gradient" and
    "YouTube ambient mode" sections go, and the live-applies table shrinks.
- **Refs:** ZPT-010, ZPT-011, ZPT-D004, ZPT-D005, [ZPT-020](#zpt-020)
  (merged in), and the archived ZPT-004 / ZPT-009.

### ZPT-022
**Page outline: make it optional — a real toggle in the settings**
- **Status:** done · **Priority:** 2 · **Sev:** low · **Area:** tint.uc.js + preferences.json (+ style.css)
- **Symptom:** the outline is drawn by default (2px) and the only way to turn
  it off is to know that `zen.page-tint.page-outline-width = 0` means "off".
  The Sine panel exposes the width as a number, which is a knob, not a switch.
- **Why:** a drawn frame around the content is the most opinionated thing this
  mod does. Some people want the tint and nothing else — the page's edge
  should not be a decision they have to make by remembering a magic number.
- **Goal:** one click in the settings panel turns the boundary off (and back
  on), without touching `about:config`.
- **Options:**
  - **A checkbox** ("Draw a page outline") next to the width entry, backed by
    a bool pref (`zen.page-tint.page-outline`, default true), with the width
    staying the thickness knob. Two prefs for one feature, but each asks one
    understandable question: *on/off* and *how thick*.
  - **One pref only** — keep `page-outline-width` and let `0` mean off, but
    present it as a switch in the panel that writes 0. Sine preferences map
    1:1 to prefs, so this is a UI-only change; the cost is a dropdown
    ("on / off") or a checkbox that writes a number.
  - **Default it off** and make it an opt-in feature. Cheapest to defend
    ("nothing new unless you ask for it"), but the outline is the whole point
    of [ZPT-019](#zpt-019) and the user asked for it.
- **Also to decide:** the outline currently forces the page's own corner radius
  to `0` (see [ZPT-019](#zpt-019)), so turning it off has to put the page's
  corners back. That part is already attribute-gated
  (`zen-page-tint-outline`), so it follows the toggle for free — as long as
  the toggle drives the same attribute.
- **Cost:** small. One bool pref, one checkbox in `preferences.json`, one case
  in the `zen.page-tint.` pref observer (set/remove the attribute, re-measure
  the outline).
- **Depends on:** nothing — this is plumbing over the existing implementation.
- **Decision:** the **checkbox** option. `zen.page-tint.page-outline` (bool,
  default true) is the switch; `page-outline-width` stays the thickness knob.
  Each pref answers one question, and neither has to encode the other. A width
  of `0` still means off, so an existing `about:config` setup keeps working.
- **Done in:** ZPT-D009.
- **Refs:** [ZPT-019](#zpt-019) (the implementation this makes optional),
  `preferences.json`, the `zen.page-tint.` pref observer, the
  `zen-page-tint-outline` attribute contract in `AGENTS.md`.

### ZPT-023
**Outline color: use the page's own visible colors instead of the favicon**
- **Status:** open · **Priority:** 3 · **Sev:** med · **Area:** frame.js (sampling) + tint.uc.js (plumbing)
- **Symptom:** the outline's color comes from the site's favicon, and in
  practice that is often the wrong answer: a monochrome logo gives no color at
  all (the neutral fallback), a multi-brand host gives another brand's color,
  a favicon that was cached from a previous page can be stale, and a logo's
  color is not necessarily a color the page is painted in. The line is drawn
  ON the page, so the color that reads best is one the page actually
  contains.
- **Goal:** collect the page's **visible colors** and pick the one that works
  as the outline — a color that appears on the page (so the line belongs to
  it), is not the page's own background (or it vanishes into it), and is
  visible against it.
- **Options / sketch:**
  - **Read the pixels and pick a dominant *chromatic* color** rather than a
    flat average: the old `content` source's grid sampler already reduces the
    viewport to a 16×16 grid; instead of averaging it, cluster the cells and
    take the most common saturated cluster, ignoring greys and the page's own
    background color.
  - **Use the favicon as a hint, not as the answer:** if the page contains a
    color close to the brand color, use the page's version of it (brand-
    accurate AND page-accurate); fall back to the brand color when the page
    has nothing close.
  - **Keep the chain as the fallback:** page colors → favicon color → the
    tint's foreground → nothing.
- **Cost:** the pixels live in the content process, so this brings the
  content side back for the outline — one more field in the theme message and
  one more IPC on a cache miss. It also changes the shape of the per-URL
  theme cache (`{ bg, edges }` would carry the outline color too), so the
  cache-invalidation rules in `AGENTS.md` apply: anything that changes what a
  sample yields has to clear the cache.
- **Conflict to settle with [ZPT-021](#zpt-021):** that ticket deletes the
  pixel sampler as part of "one behaviour". This ticket wants a narrow slice
  of it back — for the OUTLINE, not for the tint. They have to be reconciled
  explicitly (keep a small sampler for the outline only, or let this ticket
  land after ZPT-021 and re-add what it needs), rather than one silently
  undoing the other.
- **Depends on:** [ZPT-022](#zpt-022) — make the outline optional first, so a
  bad color cannot hurt anyone while the source is being reworked.
- **Refs:** [ZPT-019](#zpt-019) (the favicon implementation this replaces),
  [ZPT-021](#zpt-021) (the cleanup that deletes the pixel path), the
  `content` source's grid sampler in `frame.js`, the cache rules in
  `AGENTS.md`.

---

## Done log

Fixed items, newest first. Kept for reference so the numbers aren't reused.

_(The tracker starts at ZPT-010; earlier history is in
[`TODO-archive.md`](TODO-archive.md))_

### ZPT-D009
**Page outline is optional: a real on/off switch** — `done`
- `zen.page-tint.page-outline` (bool, default `true`) is the switch, exposed as
  a checkbox in the Sine panel right above the thickness entry;
  `zen.page-tint.page-outline-width` is now just *how thick* (`0` still means
  off, so existing `about:config` setups keep working).
- One predicate (`OUTLINE_ENABLED && OUTLINE_WIDTH > 0`) drives the
  `zen-page-tint-outline` attribute, the `--zpt-page-outline-width` variable
  (written as `0px` when off) and the element's lifecycle — so the toggle also
  puts the page's own corner radius back for free.
- Off is a real off: the outline element, its `ResizeObserver`, the site-color
  variable and any in-flight favicon lookup are torn down, and the per-tab-switch
  path early-returns instead of rebuilding them. On re-creates and re-measures
  the outline for the page that is showing **without a restart**.
- `removeOutlineElement()` now bumps the color token, so a lookup that resolves
  after teardown can't resurrect a stale site color.
- Version `1.2.0` → `1.3.0` in `theme.json` **and** the `// @version` header.

### ZPT-D008
**Page outline: the whole viewport, in the site's own color** — `done`
- A squircle stroke around the **whole** page viewport — all four sides,
  continuously — replacing the v1.1.0 hairline, which was drawn in the frame gap
  and therefore vanished on the edge facing the sidebar.
- `zen.page-tint.page-outline-width` (default 2px) replaces
  `zen.page-tint.frame-separator`. `0` = off.
- The color is the **site's** primary color, taken from its favicon by a
  chrome-side resolver (candidates → `Image` → 32×32 canvas → pixel analysis →
  exact shade or hue-family average → lightness clamp). Adapted from
  [zen-tab-groups](https://github.com/oom333/zen-tab-groups) (MIT) — credited in
  the README and the LICENSE.
- Cached per host in `zen.page-tint.icon-colors`; the per-URL theme cache is
  untouched. No IPC, no content-process change.
- Fallback chain: site color → the tint's own foreground (the old hairline) →
  no outline (an untinted page draws none).
- The outline owns the page's shape: the content container's inner radius is
  forced to `0` while the outline is on, so the two shapes don't compete.
- New invariant in `AGENTS.md`: a border MAY sit on the page's outermost
  pixels; the tint may not.
- Version `1.1.0` → `1.2.0` in `theme.json` **and** the `// @version` header.

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
