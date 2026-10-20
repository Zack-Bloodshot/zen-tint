# AGENTS.md

Guidance for agents working in this repository.

## What this is

**Zen Tint** is a [Zen Browser](https://zen-browser.app/) theme/mod,
distributed through the **Sine** mod loader. It samples the active page's
background color and tints Zen's chrome (URL bar, sidebar, titlebar, splitter,
window rim) to match it, so the browser frame looks continuous with the content.

There is **no build step, no package manager, no test suite, and no linter**. The
repo is the shipped artifact: Sine reads `theme.json`, injects `tint.uc.js` into
the browser chrome, loads `style.css`, and renders the settings panel from
`preferences.json`. "Building" means editing a file and reloading it in Zen.

## Layout

| File | Runs where | Role |
|---|---|---|
| `theme.json` | Sine manifest | Mod id/version, entry points. Loads `tint.uc.js` into `chrome://browser/content/browser.xhtml`, `style.css` as chrome style (`content` style is empty on purpose). |
| `tint.uc.js` | **Chrome** process (privileged, same scope as `browser.xhtml`) | The brain. Listens for tab/navigation events, owns the LRU cache, decides what to tint, writes CSS variables onto `<html>`, and drives the content script over the message manager. |
| `frame.js` | **Content** process (per browser, loaded via `loadFrameScript`) | The sampler. Reads the page's color, observes theme-related mutations, runs live-mode polling, and pushes colors back to chrome. |
| `style.css` | Chrome stylesheet | Consumes the CSS variables the chrome script sets and paints the tinted surfaces. Also the frame gap/radius/shadow geometry. |
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
5. `frame.js` samples, observes, and pushes `{ bg, edges, source, href }` via
   `sendAsyncMessage('zen-page-tint:theme')`.
6. Chrome applies saturation/brightness/contrast/clamp (`transformColor`), picks
   a black-or-white foreground by Rec 601 luminance (`readableFg`), writes
   `--zen-tab-header-background` / `--zen-tab-header-foreground`, and flips the
   `zen-page-tint` attribute. `style.css` does the rest.

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
  `origin + pathname`, storing `{ bg, edges }` (not `fg` — it's derived). Nothing
  may be added to this path that talks to a content process.
- **Pref reads must not share a `try`.** `Services.prefs.get*Pref` throws on a
  wrong-*type* pref (the default arg only covers *missing*), so one mistyped
  `about:config` entry would otherwise revert every later pref. Use the
  `prefBool` / `prefInt` / `prefStr` helpers, each with its own `try`.
- **Restart vs live prefs.** The live-mode group is read **once** at chrome-script
  load and needs a restart (Sine shows the restart toast via `"restart": true` in
  `preferences.json`). The CSS-variable and color-source prefs are applied live
  through the `zen.page-tint.` prefix observer. New prefs must land in the right
  bucket and be annotated with the matching comment here.
- **Editing the sample chain may invalidate the cache's shape.** The cache stores
  the *result*, not the pixels. Anything that changes what a sample yields (e.g.
  `ambient-spread` crossing 0, which flips whether edges are computed at all)
  must `themeCache.clear()`. Don't clear per-element; clear and re-sample.
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
  page), `zen-page-tint-live` (live mode on).
- **Version lives in two places** and must move together: `theme.json` `version`
  and the `// @version` header in `tint.uc.js`. Commit history uses
  `Release vX.Y.Z: <summary>`, `fix: ...`, `docs: ...`.
- Surface-level geometry knobs (`--zpt-frame-gap`, `--zpt-frame-radius`) are
  prefs, but `--zpt-frame-shadow` is still a raw CSS knob in `style.css` `:root`.

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
   only; an `about:` page (should keep Zen's default chrome); a
   per-site-disabled host; `prefers-color-scheme` flip; live mode on a playing
   video; `ambient-spread` above 0 (gradient) and back to 0; the settings panel
   applying each live pref without a restart.

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
3. Install from `https://github.com/caezium/zen-tint` in Sine. Sine writes the
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
