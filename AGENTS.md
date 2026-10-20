# AGENTS.md

Guidance for agents working in this repository.

## What this is

**Zen Tint** is a [Zen Browser](https://zen-browser.app/) theme/mod,
distributed through the **Sine** mod loader. It reads the active page's
background color and tints Zen's chrome (URL bar, sidebar, titlebar, splitter,
window rim) to match it, so the browser frame looks continuous with the content.

The color comes from one of two sources, chosen by `zen.page-tint.color-source`:
the page's **declared** background (`page-background`, the default — the color
the page itself says it sits on) or the **painted pixels** (`content` — what is
actually on screen, video-aware). See "Sample chain in `frame.js`" below.

There is **no build step, no package manager, no test suite, and no linter**. The
repo is the shipped artifact: Sine reads `theme.json`, injects `tint.uc.js` into
the browser chrome, loads `style.css`, and renders the settings panel from
`preferences.json`. "Building" means editing a file and reloading it in Zen.

## Layout

| File | Runs where | Role |
|---|---|---|
| `theme.json` | Sine manifest | Mod id/version, entry points. Loads `tint.uc.js` into `chrome://browser/content/browser.xhtml`, `style.css` as chrome style (`content` style is empty on purpose). |
| `tint.uc.js` | **Chrome** process (privileged, same scope as `browser.xhtml`) | The brain. Listens for tab/navigation events, owns the LRU cache, decides what to tint, writes CSS variables onto `<html>`, drives the content script over the message manager, and colors the page outline (the page color the frame sampled, with the favicon as fallback; the outline's geometry is CSS, not JS). |
| `frame.js` | **Content** process (per browser, loaded via `loadFrameScript`) | The sampler. Reads the page's color and the drawn outline's page color, observes theme-related mutations, runs live-mode polling, and pushes colors back to chrome. |
| `style.css` | Chrome stylesheet | Consumes the CSS variables the chrome script sets and paints the tinted surfaces. Also the frame gap/radius/shadow geometry, and the page outline's layout border. |
| `preferences.json` | Sine settings panel | Every entry maps 1:1 to a `zen.page-tint.*` pref in `about:config`. Cosmetic only — the defaults live in the JS. |
| `README.md` | Users | Long, deliberately detailed. Keep it accurate; it is referenced from the Sine store listing. |
| `assets/` | Users | Demo GIFs / social card used by the README. |

`frame.js` is loaded by the chrome script from the packaged path
`chrome://sine/content/zen-tint/frame.js` (Sine maps the repo into that
mount). Editing `frame.js` therefore only takes effect once the mod is
repackaged/reloaded into Zen, not from a bare file copy.

## Architecture (how a tint happens)

1. Chrome script fires on `TabSelect`, top-level `onLocationChange`, initial
   load, OS `prefers-color-scheme` change, and Glance expand.
2. Events coalesce through `requestAnimationFrame` **raced against** a 100 ms
   `setTimeout` safety net (`scheduleSample`/`runScheduled`). The timeout exists
   because rAF is throttled when the window is occluded.
3. Cache hit → apply instantly, **zero IPC** (`applyTheme` → `renderTint`).
4. Cache miss → `loadFrameScript(browser)`, which also pushes config.
5. `frame.js` samples, observes, and pushes `{ bg, edges, outlineColor, source,
   href }` via `sendAsyncMessage('zen-page-tint:theme')`.
6. Chrome applies saturation/brightness/contrast/clamp (`transformColor`), picks
   a black-or-white foreground by Rec 601 luminance (`readableFg`), writes
   `--zen-tab-header-background` / `--zen-tab-header-foreground`, and flips the
   `zen-page-tint` attribute. `style.css` does the rest.
7. Separately, the chrome **colors** the page outline. The outline itself is a
   real CSS border on `#zen-tabbox-wrapper` (`style.css`) — the page is laid
   out inside the stroke, and the border's presence, shape and clip are pure
   CSS state (attribute gates, with fullscreen and glance exceptions); the
   chrome owns no outline geometry. Its color is `outlineColor` from the
   sample — a chromatic color found in the page's own visible pixels — with
   the site's favicon (cached per host in `zen.page-tint.icon-colors`) as the
   fallback when the page has none. The favicon path is chrome-side only; the
   page-color path is one extra grid read in the frame, carried in the same
   message and the same theme-cache entry.

**Message names** (both scripts hardcode them; keep them in sync):
`zen-page-tint:theme` (content→chrome), `zen-page-tint:config` (chrome→content),
`zen-page-tint:teardown` (chrome→content), `zen-page-tint:ready`
(content→chrome handshake).

**Sample chain in `frame.js`** (first match wins, everything normalized to
canonical `rgb(r, g, b)`):
`yt-ambient` → `pixel` (`drawWindow` of the central 60% on a 16×16 grid) →
`<meta name="theme-color">` → `body` background → `html` background → walk up
from `elementFromPoint`. Per the README's contributing rule: **if you add a
step, add a one-liner explaining the case it catches that the existing steps
miss.**

**Second source (`zen.page-tint.color-source = page-background`, the default)** —
*replaces* that chain rather than extending it: `body` computed background →
`html` computed background → null, which clears the tint back to Zen's theme.
No `drawWindow`, no `<meta name="theme-color">`, no DOM walk, and never any edge
colors — it answers "what does the page declare?" rather than "what is
painted?", and the two questions have different right answers. A single declared
color has no spatial content, so `ambient-spread` is inert under this source.

**The outline color is a separate read, on either source.** `readOutlineColor()`
draws the whole viewport onto its own 32×32 grid (`drawWindow`, smoothing left
on) and picks the most common **chromatic** hue family, skipping greys and cells
close to the page background, then clamps the result to read against that
background. It is gated by `config.outline` (the outline pref/width), never by
`color-source`: the tint may follow the declared background while the line still
takes a color the page contains. With the outline off, the declared path really
is two computed styles and no compositor read. The favicon resolver in
`tint.uc.js` survives as the fallback for pages that yield no color (monochrome,
all-background), so the chain is **page color → favicon → the tint's own
foreground → nothing**.

## Hard invariants — read before editing

These are load-bearing. Violating them is how this project regressed before
(see git history: "fix 10 reported issues", "#11", "#14").

- **One tint layer per pixel.** `--zpt-tint` is *translucent* below 100%
  strength, and translucent layers composite. Never add
  `background-color: var(--zpt-tint)` to an element that already sits over a
  tinted ancestor, or that region renders a different strength than its
  neighbours. Containers whose only job is to hold a tinted child are set
  `transparent` on purpose.
- **Never touch `.messageManager` on a lazy tab.** Reading it on a restored-but-
  unloaded tab trips the property trap that instantiates it. At the target tab
  counts (1300+) an unguarded sweep hangs the window for seconds on close /
  hot-reload. Guard with `tab.linkedPanel` (the same idiom tabbrowser uses).
- **Do not iterate `gBrowser.browsers` to push config eagerly.** Cache
  invalidation is the correct propagation: every tab becomes a miss, and the miss
  path already reloads the frame script. Iterating floods IPC and hangs the
  window (observed at ~1660 tabs).
- **No transitions on `.tabbrowser-tab`, and no `color`/`box-shadow`
  transitions on the tab-strip containers.** Thousands of inheriting elements
  interpolating saturates the compositor. Only `background-color` fades on the
  chrome surfaces; `color` and `box-shadow` snap.
- **Cache-hit path stays zero-IPC.** Cache is a bounded LRU keyed by
  `origin + pathname`, storing `{ bg, edges, outlineColor }` (not `fg` — it's
  derived). Nothing may be added to this path that talks to a content process.
- **Pref reads must not share a `try`.** `Services.prefs.get*Pref` throws on a
  wrong-*type* pref (the default arg only covers *missing*), so one mistyped
  `about:config` entry would otherwise revert every later pref. Use the
  `prefBool` / `prefInt` / `prefStr` helpers, each with its own `try`.
- **Restart vs live prefs.** The live-mode group is read **once** at chrome-script
  load and needs a restart (Sine shows the restart toast via `"restart": true` in
  `preferences.json`). The CSS-variable prefs, `zen.page-tint.color-source`,
  `zen.page-tint.page-outline` and `zen.page-tint.page-outline-width` are applied
  live through the `zen.page-tint.` prefix observer. New prefs must land in the
  right bucket and be annotated with the matching comment here.
- **The outline's geometry is chrome CSS, and its selectors are load-bearing.**
  The outline is a real border on `#zen-tabbox-wrapper` — the page is laid out
  inside it, so nothing is re-measured in JS. That makes the selector the
  contract: if a future Zen renames or re-boxes `#zen-tabbox-wrapper`, the
  outline dies with it (the symptom is no boundary and no clipping — the
  fallback is a border on `.browserSidebarContainer`, Wireframe's unproven
  alternative). The fullscreen and glance exceptions are also CSS states
  (`:root[inDOMFullscreen]` / `:root[sizemode="fullscreen"]` /
  `:has(.browserSidebarContainer.zen-glance-overlay)`): a DOM change to those
  shapes breaks the guards silently.
- **A config change that alters what a sample yields must re-sample in the
  frame.** The color source lives in the content process, so the chrome side
  can't force a re-sample under new rules — it can only push the new config and
  clear its cache. `singleton.applyConfig()` compares a signature of the
  result-affecting config fields (`colorSource`, `ytAmbient`, `lightAverage`,
  `edges`, `outline`) and re-samples when it changes. Without it the new rules only take
  effect on the next mutation / poll tick / tab switch, and on a static page
  with no video none of those may ever happen — the chrome would keep showing
  the old source's color indefinitely.
- **Editing the sample chain may invalidate the cache's shape.** The cache stores
  the *result*, not the pixels — `{ bg, edges, outlineColor }` today. Anything
  that changes what a sample yields (e.g. `ambient-spread` crossing 0, which
  flips whether edges are computed at all, or the outline switch, which flips
  whether the outline color is sampled) must `themeCache.clear()`. Don't clear
  per-element; clear and re-sample.
- **`frame.js` singleton is anchored on `globalThis`, not `content`.** `content`
  is a fresh window per navigation; anchoring there caused listener/poller
  accumulation. Per-document state lives in the `instance` and is disposed on
  reload.
- **`drawWindow` is non-standard** but is the ground-truth path. If it disappears
  upstream, the meta/computed-style fallbacks still work but Gmail-class accuracy
  is lost. Don't remove it.
- **Don't try to read YouTube's `#cinematics` canvas.** It is CORS-tainted by the
  cross-origin `googlevideo.com` stream and `getImageData` throws once playback
  starts. The code reads the compositor via `drawWindow` on the video's picture
  box instead. The long comment there records the failed first attempt.

## Conventions

- **Comment style is unusually heavy on purpose.** Comments explain *why* — the
  tradeoff, the rejected alternative, the bug number. Match that. A terse diff
  with no rationale will read as unfinished here.
- 2-space indent, single quotes, semicolons, `'use strict'`, one IIFE per file,
  no imports/exports. Modern Gecko-chrome JS (optional chaining, `??`, class
  fields) is fine.
- Host lists use `parseHostList` / `hostMatches`: comma-separated, `*.example.com`
  matches subdomains but **not** the bare `example.com`, matched against
  `URL.hostname` so entries are port-independent.
- Attribute contract between JS and CSS: `zen-page-tint` (a page is tinted),
  `zen-page-tint-ambient` (gradient edges present), `zen-page-tint-active`
  (mod loaded — smoothing is scoped to this so the fade survives leaving a tinted
  page), `zen-page-tint-live` (live mode on), `zen-page-tint-outline` (the drawn
  boundary is on — this also decides the page's own corner shape). The outline
  attribute follows `zen.page-tint.page-outline` AND a non-zero
  `page-outline-width`, so both ways of saying "off" put the page's own corners
  back; while it is off neither the border nor the page clipping exists in the
  CSS at all.
- **Version lives in two places** and must move together: `theme.json` `version`
  and the `// @version` header in `tint.uc.js`. Commit history uses
  `Release vX.Y.Z: <summary>`, `fix: ...`, `docs: ...`.
- Surface-level geometry knobs (`--zpt-frame-gap`, `--zpt-frame-radius`,
  `--zpt-page-outline-width`) are prefs, but `--zpt-frame-shadow` and
  `--zpt-page-outline-radius` are still raw CSS knobs in `style.css` `:root`.
- **The page outline is a LAYOUT border, and never an overlay.** It is a real
  CSS `border` on `#zen-tabbox-wrapper` (ZPT-024): the page is laid out inside
  the stroke, so the page ENDS where the line starts and not a single page
  pixel is painted over. Before v1.5.0 it was a fixed-position stroke over
  the page's outermost pixels — "a border is allowed to sit on the page's
  outermost pixels" was the old invariant, and ZPT-024's screenshots (the
  line cutting through YouTube's thumbnail row and duration badges) proved
  that trade-off unacceptable. **The tint is still forbidden from covering
  the page** — it only ever paints chrome surfaces, and that rule did not
  change. Keep the two jobs separate: the outline is near the page (beside
  it, at the layout edge), the tint is on the chrome.
- **The drawn outline owns the page's corner shape.** While it is on, the
  wrapper's `overflow: hidden` clips the page to the border's inner edge
  (radius minus width), and the content container's `--zen-native-inner-radius`
  is forced to `0`: a page rounding its own corners inside the outline's
  squircle clip reads as two competing shapes at the same corner. The
  outline's radius is a CSS knob (`--zpt-page-outline-radius`), kept close to
  the frame radius so the outline's corners sit just inside the chrome's
  corners. Fullscreen (DOM fullscreen and `sizemode="fullscreen"`) removes
  the border AND the clip entirely — fullscreen is not a boundary state — and
  a Glance drops just the border width for the glance's lifetime.
- **A CSS exclusion guard must OUT-SPECIFY the rule it fights.** Every guard
  here (`inDOMFullscreen` / `sizemode="fullscreen"` / the Glance `:has()`) is
  `!important` against an `!important` border rule, and an `!important` tie
  goes to specificity, not to file order — the v1.5.0 fullscreen guards
  carried one attribute gate against the border rule's three
  ((0,1,1,0) vs (0,1,3,0)) and silently lost: the line survived fullscreen
  (ZPT-025). The guards therefore repeat the border rule's own gates and sit
  one specificity level above it; if the border rule's selector changes,
  change the guards with it.

## Testing / verifying a change

There is no automated harness. Verify in a real Zen build:

1. Install via Sine (marketplace, or "add locally from a GitHub repo" pointing at
   this repo). A local/unvetted install needs
   `sine.allow-unsafe-js = true` in `about:config` for `tint.uc.js` to load.
2. Enable the mod and restart Zen.
3. Set `zen.page-tint.debug = true` to get `[zen-tint]` /
   `[zen-tint frame]` logs in the Browser Console (`Ctrl/Cmd-Shift-J`).
4. Manual checklist: tab switch on a light and a dark page; revisit a tab (should
   be a zero-IPC cache hit); a page whose color is in `<meta name="theme-color">`
   only; an `about:` page (should keep Zen's default chrome and draw **no**
   outline); a per-site-disabled host; `prefers-color-scheme` flip; live mode on
   a playing video; `ambient-spread` above 0 (gradient) and back to 0; the
   settings panel applying each live pref without a restart.
5. Outline checklist: the boundary is a real border — the page is laid out
   inside it, so on YouTube (or any page with content flush to the viewport
   edge) no text, thumbnail or duration badge sits under the line; it is drawn
   on **all four** sides (especially the one against the sidebar); corners are
   continuous, with no page wedge outside the line; it is in a color **the
   page contains**, not a grey and not necessarily the favicon's color; it is
   visible against the page (a dark line on a light page, a light one on a
   dark page); a page with no chromatic color (a monochrome or all-background
   page) falls back to the site's brand color, and with neither it falls back
   to a neutral line; tab switch, window resize, sidebar expand/collapse and
   compact-mode transitions keep the line on the page edge **without any JS
   re-measure**; it disappears on an `about:` page and on a
   per-site-disabled host; `zen.page-tint.page-outline = false` turns it off
   entirely (both the border and the page clipping go, and the page's own
   radius comes back), as does `zen.page-tint.page-outline-width = 0`; turning
   either back on restores it immediately, without a restart; fullscreen video
   (DOM fullscreen) and whole-window fullscreen show **no** border at all, and
   entering/leaving restores it with no stale line over the page; a Glance
   draws no line while it is open; menus, the findbar, PiP, devtools and the
   library survive the wrapper's overflow clip; split view draws ONE
   rectangle around all panels (known limitation).

Performance is the product. When in doubt, measure tab-switch latency under a
large tab session before and after, and prefer the cheaper path.

## Publishing / updating via GitHub (Sine update flow)

Sine has no push hook and no folder scanner. It reads `chrome/sine-mods/mods.json`
(`utils.getMods()` → `IOUtils.readJSON`) and only checks installed entries. A repo
is picked up once, then updated from Git **at startup** (or when the user clicks
"check for updates"). The flow that works, verified against the installed engine:

**One-time install**

1. The repo must be **public** — Sine fetches `raw.githubusercontent.com` and
   `codeload.github.com`, neither of which authenticates, so private repos cannot
   install or update.
2. Push with the default branch named **`main`** (Sine assumes `main`; a
   `/tree/<branch>` install URL is the only way to use another name).
3. Install from `https://github.com/Zack-Bloodshot/zen-tint` in Sine. Sine writes the
   entry to `mods.json` with `homepage`, `updatedAt`, `enabled: true`,
   `no-updates: false`, and **no `origin`**.

**Every subsequent push**

1. Bump `version` in `theme.json` **and** `// @version` in `tint.uc.js` (convention,
   not what triggers the update).
2. `git commit` (`Release vX.Y.Z: <summary>` / `fix:` / `docs:`).
3. `git push origin main`.

That is enough. On the next Sine startup (or manual update check) it:

- fetches `theme.json` from the raw URL;
- because this repo's `theme.json` intentionally has **no `updatedAt`**, falls back
  to the GitHub API repo `updated_at`;
- compares `installed.updatedAt < remote.updatedAt` — **timestamps, not the
  version string**;
- if newer, downloads the **whole repo ZIP** (`codeload…/zip/main`), deletes and
  replaces `sine-mods/zen-tint/`, rewrites `mods.json`, and calls
  `rebuildMods()` + `loadMods()`.

**Invariants and traps**

- Keep `theme.json`'s `id` as `zen-tint`, `homepage` pointed at the repo,
  `no-updates: false`, and `enabled: true`. A malformed `theme.json` makes the
  check silently find nothing.
- **`theme.json`'s `homepage` must point at THIS repo.** Sine does not overwrite
  it with the URL you installed from — `createThemeJSON()` only fills in
  `homepage` when `theme.json` has none (`setProperty` skips existing keys).
  A `homepage` left pointing at the upstream project makes the startup
  auto-check fetch the upstream `theme.json`, see a newer timestamp, and replace
  the installed folder with the upstream's code — silently, with no error.
- The mod `id` and the frame-script mount path must move together: the frame
  script is loaded from `chrome://sine/content/<id>/frame.js`, and `id` is the
  folder name Sine unpacks the repo into. Renaming one without the other leaves
  the frame script pointing at a path that doesn't exist.
- **Do not add `updatedAt` back to `theme.json`.** With it present, only changes
  to that field trigger updates; without it, any push (even a README edit) bumps
  the repo timestamp and counts.
- Never set `origin: "store"` manually — `syncModData` strips it, and store
  entries are resolved through the marketplace instead of the repo.
- Auto-check runs **only once at startup**; there is no poll loop. Manual check is
  the "check for updates" button.
- An update is a **full ZIP replace**, so anything written into
  `sine-mods/zen-tint/` by `sync-to-zen.sh` is lost the next time Sine updates.
  Push first, then update — or use the sync script only for local preview of
  unpushed work.

## Local-only tooling

`.gitignore` lists `sync-to-zen.sh` and `.scguard/` — a dev's local
sync/guard scripts. They are intentionally not committed; do not add them.

`sync-to-zen.sh` copies files straight into `sine-mods/<id>/`; it does **not**
register the mod (Sine never scans folders, see the update flow above) and its
copies are overwritten by the next GitHub update. Use it for local preview of
unpushed work, not as the install path.

## License

MIT. See `LICENSE`.
