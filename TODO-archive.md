# TODO

Local issue tracker for **Zen Page Tint**. Plain markdown, no external service —
edit it in place, one entry per issue, keep IDs stable and never reuse them.

- **Scope:** issues and work items for this repo only (`tint.uc.js`, `frame.js`,
  `style.css`, the manifest, docs).
- **Not for:** Zen/Sine upstream bugs, or Gecko platform bugs (link them, don't
  own them).
- **Conventions:** see [Adding an entry](#adding-an-entry). Read `AGENTS.md` for
  the invariants a fix has to respect — several open items below touch the
  sampling path, which is performance-sensitive.

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
| [ZPT-001](#zpt-001) | accepted | low | frame.js | Live Boost edits need a page refresh to re-tint |
| [ZPT-002](#zpt-002) | accepted | low | frame.js | Live mode can't auto-detect video in cross-origin iframes |
| [ZPT-003](#zpt-003) | accepted | low | frame.js | YouTube fullscreen drops the ambient gate |
| [ZPT-004](#zpt-004) | blocked | med | frame.js | `drawWindow` may be removed in a future Gecko |
| [ZPT-005](#zpt-005) | open | low | — | Windows is unverified |
| [ZPT-006](#zpt-006) | open | low | manifest | Version string duplicated across two files |
| [ZPT-007](#zpt-007) | open | med | — | No automated test or CI |
| [ZPT-008](#zpt-008) | open | low | style.css | Scroll-time repaint hitch at very high tab counts |
| [ZPT-009](#zpt-009) | open | low | frame.js | Opposite-hue content averages to grey (light-average mode) |

---

## Open / tracked items

### ZPT-001
**Live Boost edits need a page refresh to re-tint**
- **Status:** accepted · **Sev:** low · **Area:** frame.js (observers)
- **Symptom:** editing a Zen Boost on an already-loaded page doesn't update the
  chrome tint until you refresh, or switch away and back.
- **Why:** Boosts apply via `CSSStyleSheet.insertRule` and browser-level
  user-stylesheets, neither of which fires a DOM `MutationObserver`, so the
  sampler is never woken.
- **Options:** background polling would catch it but at a constant CPU cost.
  Judged not worth it. Revisit only if it's reported more than once.
- **Workaround:** refresh the page.

### ZPT-002
**Live mode can't auto-detect video in cross-origin iframes**
- **Status:** accepted · **Sev:** low · **Area:** frame.js (`checkVideoState`)
- **Symptom:** a YouTube/Vimeo/Spotify embed on a third-party page doesn't trigger
  live polling.
- **Why:** the `<video>` lives in a separate browsing context, so its play/pause
  events never reach the parent document. The tint *would* be correct if polling
  ran — only the trigger is missing.
- **Workaround:** add the host to `zen.page-tint.live-mode-hosts` to force
  always-on polling. Documented in the README.
- **Note:** same-origin pages (youtube.com itself) work without this.

### ZPT-003
**YouTube fullscreen drops the ambient gate**
- **Status:** accepted · **Sev:** low · **Area:** frame.js (`readYouTubeAmbient`)
- **Symptom:** in fullscreen video mode the ambient path stops matching and falls
  back to the centered viewport read.
- **Why:** fullscreen removes the `#cinematics` element the ambient path gates on.
- **Impact:** minor — in fullscreen the centered read *is* the video, just without
  the letterbox trimming. Outside fullscreen the ambient path handles it.
- **Idea:** gate on fullscreen state independently of `#cinematics`. Only worth
  it if the fallback proves visibly wrong on letterboxed fullscreen video.

### ZPT-004
**`drawWindow` may be removed in a future Gecko**
- **Status:** blocked (upstream) · **Sev:** med · **Area:** frame.js (pixel path)
- **Symptom:** none today. Risk item.
- **Why:** `ctx.drawWindow` is flagged non-standard in MDN but is still present in
  current Gecko. It is the ground-truth sample path and what gives Gmail-class
  accuracy.
- **If it disappears:** the meta-tag and computed-style fallbacks still work, but
  accuracy drops. No drop-in replacement exists today.
- **Action:** watch MDN / Gecko release notes. Also the reason YouTube ambient
  reads the compositor instead of the (CORS-tainted) `#cinematics` canvas.

### ZPT-005
**Windows is unverified**
- **Status:** open · **Sev:** low · **Area:** — (compatibility)
- **Symptom:** none known; untested.
- **Why:** developed on macOS, confirmed on Linux, never run on Windows.
  Selectors target Zen's stable chrome IDs, so it *should* work.
- **Action:** needs a Windows Zen user to run the manual checklist in `AGENTS.md`.
  Ask for a report rather than guessing at platform-specific fixes.

### ZPT-006
**Version string duplicated across two files**
- **Status:** open · **Sev:** low · **Area:** manifest
- **Symptom:** the version lives in both `theme.json` (`"version"`) and
  `tint.uc.js` (the `// @version` header). They can silently drift.
- **Why it matters:** the Sine listing reads `theme.json`; the script header is
  informational. A release that bumps one and not the other ships inconsistent.
- **Options:** a tiny check script, or a pre-release grep. A build step is
  probably overkill for a 3-file mod — but a check is cheap.
- **Note:** documented as a convention in `AGENTS.md`; this is the mechanical
  enforcement of it.

### ZPT-007
**No automated test or CI**
- **Status:** open · **Sev:** med · **Area:** —
- **Why it matters:** the invariants in `AGENTS.md` (one tint layer per pixel, no
  per-tab transitions, zero-IPC cache hits) are exactly the kind of thing that
  regresses silently and only shows up as a perf cliff at high tab counts.
- **Problem:** the interesting surface is a live Zen window — there's no headless
  harness, and Sine mods only run inside Zen.
- **Realistic scope:** the pure functions are testable in isolation — `parseRgb`,
  `rgbToHsl`/`hslToRgb`, `transformColor`, `readableFg`, `edgeStop`,
  `parseHostList`/`hostMatches`, `reduceGrid`. A plain node script with assertions
  over those would already catch arithmetic regressions. Everything else stays
  manual (see `AGENTS.md` checklist).

### ZPT-008
**Scroll-time repaint hitch at very high tab counts**
- **Status:** open · **Sev:** low · **Area:** style.css (transitions)
- **Symptom:** animating `background-color` on the tab-strip surfaces repaints
  them; if a color change lands while the sidebar is being scrolled it can hitch
  at very high tab counts.
- **Why:** documented tradeoff in `style.css` — the smooth fade was kept over
  scroll-awareness because chrome scroll events proved unreliable (fire
  spuriously).
- **Action:** only revisit with a reliable "user is scrolling" signal. Do not
  trade the fade away speculatively. User-side mitigation exists: lower
  live-mode rate / raise threshold.

### ZPT-009
**Opposite-hue content averages to grey (light-average mode)**
- **Status:** open · **Sev:** low · **Area:** frame.js (`reduceGrid`, LIGHT mode)
- **Symptom:** a scene with equal amounts of two opposing saturated hues (red
  beside cyan) averages to muddy grey rather than reading as either.
- **Why:** chroma weighting can't rescue it — equal-chroma complements cancel at
  any weight. Only dominant-color clustering fixes it.
- **Why not done:** clustering flips discontinuously between frames, which would
  make the chrome jump during live polling.
- **Idea:** clustering with hysteresis / temporal smoothing. Speculative; only if
  users notice. Note this is `light-average` mode only (off by default), so it's
  low priority.

---

## Done log

Fixed items, newest first. Kept for reference so the numbers aren't reused.

### ZPT-D003
**Compact mode + Glance issues** — `done`
- **Repo refs:** `#11`
- Compact mode kept flush (`margin: 0`) so Zen's screen-edge hover triggers keep
  working, and the frame shadow was dropped there (nowhere to sit).
- URL bar text handed back to Zen on `[breakout-extend]` so the floating results
  panel stays contrast-correct on a light page.
- Removed the stray `overflow: visible` on `.browserSidebarContainer` that let
  web content hit-test into the topbar hover zone (the "twitch").
- Glance overlay container kept transparent so the dimmed parent shows through the
  remaining 20%.

### ZPT-D002
**Non-uniform tint below 100% strength** — `done`
- **Repo refs:** `#14`
- **Cause:** `--zpt-tint` is translucent, and translucent layers composite — Zen's
  chrome is deeply nested, so the same color was painted a different number of
  times per region (window rim at 50%, sidebar foot buttons at ~96.9%).
- **Fix:** exactly one element paints the tint over any given pixel; containers
  that merely hold a tinted surface are set `transparent`.
- **Invariant:** now guarded in `AGENTS.md`.

### ZPT-D001
**Stray tint column at the sidebar's content edge** — `done`
- `.zen-workspace-tabs-section`'s box overhangs the sidebar's content-facing edge;
  tinted, it painted as a stray column over the page. Its background is cleared
  while the visible tabs stay tinted via the parent `#navigator-toolbox`.

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
  Those were diagnosed and fixed (see [Done log](#done-log) and `AGENTS.md`);
  regressions there are bugs against a known invariant, not features.
- **Perf items need a measurement**, not a hunch. The product is tab-switch
  latency at high tab counts.
