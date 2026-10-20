// Zen Tint — frame script
// Loaded into the content process via mm.loadFrameScript.
// Reads the page's effective background color and the color for the drawn page
// outline, observes theme-related DOM mutations, re-samples on load/pageshow, and
// pushes results to the chrome process via sendAsyncMessage.
//
// Lifecycle:
//   - The persistent singleton (config + teardown message listeners, stored on the
//     frame-script global `globalThis`) is installed ONCE per content process. It
//     survives loadFrameScript re-execution, which chrome triggers on every
//     navigation and every cache-miss tab select.
//   - A per-document "instance" (canvas, observers, event listeners, poll loop) is
//     rebuilt on each (re)load and torn down cleanly first. Anchoring the install
//     guard on `globalThis` (process lifetime) instead of `content` (per-document)
//     is what prevents the listener/poller accumulation that the old guard caused —
//     `content` is a fresh window object after every cross-document navigation.
//
// Notes:
//   - All sampled colors are normalized to canonical `rgb(r, g, b)` before being sent
//     (every path routes through normalizeColor / readPixel), so the chrome side can
//     rely on a single format.
//   - drawWindow() is the ground-truth fallback; it's flagged non-standard in MDN but is
//     still present in current Gecko. If it disappears upstream, this script keeps working
//     for the meta-tag and computed-style paths but loses Gmail-class accuracy, and the
//     outline's page-color sample falls back to the favicon on the chrome side.

(() => {
  'use strict';

  const MESSAGE_NAME = 'zen-page-tint:theme';
  const CONFIG_MESSAGE_NAME = 'zen-page-tint:config';
  const TEARDOWN_MESSAGE_NAME = 'zen-page-tint:teardown';
  // Sent to chrome once our listeners are live, asking for config to be pushed.
  // Without this the config delivery races: chrome calls loadFrameScript() and
  // then immediately sendAsyncMessage(config), but a message manager does not
  // queue messages for listeners that aren't registered yet — so on a content
  // process's FIRST load the config can arrive before addMessageListener() below
  // has run and be dropped silently. The symptom is live mode never starting
  // (liveRateMs stays 0) with no error anywhere.
  const READY_MESSAGE_NAME = 'zen-page-tint:ready';

  // Already installed in this frame-script scope? A re-load means chrome wants a
  // fresh sample for the (possibly new) document — rebuild per-document state and
  // return. The heavy persistent listeners below are NOT re-registered.
  if (globalThis.__zenPageTint) {
    try { globalThis.__zenPageTint.reload(); }
    catch (e) { try { console.error('[zen-tint frame] reload failed:', e); } catch {} }
    return;
  }

  try {
    // ---- Sampling layout ----
    //   - Source: a centered rectangle covering PIXEL_SAMPLE_FRACTION of the
    //     viewport (default 60%). The outer margin is skipped because that's
    //     typically where scrollbars/overlays/content edges live.
    //   - Destination: a PIXEL_SAMPLE_GRID x PIXEL_SAMPLE_GRID canvas. We scale
    //     the source region into the grid (drawWindow + the GPU do the downsample)
    //     then average non-transparent cells for the dominant central tone.
    const PIXEL_SAMPLE_FRACTION = 0.6;
    const PIXEL_SAMPLE_GRID = 16;
    // The outline's own read is a separate, coarser question: "which colours are
    // visible on this page?", not "what is the page's average colour?". It uses
    // its own grid and canvas (see readOutlineColor) so the tint path's buffer
    // and geometry stay untouched.
    const OUTLINE_SAMPLE_GRID = 32;
    // A cell must be this saturated to count as a colour rather than a grey.
    // Cells are averages of a ~45x28 patch (smoothing is left ON for this read),
    // which washes out thin text and one-pixel fringes but keeps solid areas —
    // a button, a header, a photo — at close to their real colour.
    const OUTLINE_MIN_SATURATION = 0.25;
    // Minimum max-channel distance from the page's own background. A cell this
    // close to the background would draw a line that vanishes into it.
    const OUTLINE_BG_DISTANCE = 32;
    // How many cells a hue family needs before it is believable. Low on purpose:
    // a small solid accent (one button) covers only a couple of cells at this
    // resolution, and a brand colour is usually a minority of the page.
    const OUTLINE_MIN_CELLS = 2;
    const VIDEO_CHECK_DEBOUNCE_MS = 250;
    const SAMPLE_DEBOUNCE_MS = 250;
    // Safety floor only — guards against an absurd pref value (rate = 5) pinning a
    // core. The configured rate is otherwise used verbatim.
    //
    // There used to be an adaptive scheme here: poll at rate ÷ 4 while the color
    // was changing, back off to the configured rate once stable. It was the wrong
    // model. On video the color changes every single tick, so the fast rate became
    // the permanent state and the configured rate was never reached — meaning the
    // one number exposed in settings did nothing except set a ceiling. It also put
    // the poll interval below the smoothing duration, so the chrome was perpetually
    // mid-fade and never actually arrived at a color. The video-playing gate
    // already covers the CPU concern that adaptivity was there to solve.
    const LIVE_RATE_FLOOR_MS = 100;

    // Theme-affecting attributes worth re-sampling on. Filtered so ordinary
    // aria-*/data-time/class churn doesn't wake a drawWindow read.
    const THEME_ATTRS = [
      'class', 'style', 'theme', 'color-scheme',
      'data-theme', 'data-mode', 'data-bs-theme', 'data-color-scheme',
      'data-color-mode', 'data-dark-mode', 'data-prefers-color-scheme',
    ];

    // ---- Color averaging ----
    //
    // Two modes, because "what color is this page?" and "what light is this video
    // giving off?" are different questions and want different math.
    //
    // FLAT (default for page samples): the plain sRGB mean. Matches the mental
    // model that chrome should look like the page's background — a mostly-dark
    // page stays dark even when something bright is on screen.
    //
    // LIGHT (always used for the video/ambient path): sRGB channels are
    // gamma-encoded (~2.2 power curve), so averaging them directly underestimates
    // actual light — half black and half white averages to 127 when the real light
    // average re-encodes to 188. Decoding to linear light, averaging, and
    // re-encoding models light spill, which is exactly what an ambient glow is.
    // Applied to page samples it reads as "too bright" (a 94%-dark page with a
    // small bright logo jumps from rgb(33,33,33) to rgb(74,74,74)), hence the
    // split. The 256-entry LUT turns each decode into an array read.
    const SRGB_TO_LINEAR = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const c = i / 255;
      SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    function linearToSrgb8(v) {
      const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      return Math.max(0, Math.min(255, Math.round(s * 255)));
    }

    // HSL is the space the outline pick works in: hue puts a cell in a family,
    // saturation decides whether it is a colour at all, and lightness decides
    // whether it will read against the page. Small, dependency-free versions —
    // the chrome side has its own copies for the tint transform.
    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      if (d === 0) return { h: 0, s: 0, l };
      const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      let h;
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
      return { h, s, l };
    }
    function hslToRgb(h, s, l) {
      if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const hue = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      return {
        r: Math.round(hue(h + 1 / 3) * 255),
        g: Math.round(hue(h) * 255),
        b: Math.round(hue(h - 1 / 3) * 255),
      };
    }

    // In LIGHT mode, vivid cells outweigh gray ones so a saturated minority isn't
    // washed out by a neutral majority — a dark UI with a red scene in it reads
    // red rather than muddy brown. Note this does NOT rescue two opposing
    // saturated hues: equal-chroma complements (red beside cyan) still cancel to
    // gray at any weighting, since they're weighted equally. Only dominant-color
    // clustering fixes that case, and clustering flips discontinuously between
    // frames, which would make the chrome jump during live polling.
    const CHROMA_WEIGHT = 2;

    // How many columns/rows in from each edge form a directional band. At grid 16
    // a band of 6 gives left = x 0..5, right = x 10..15, leaving 6..9 belonging to
    // neither, so the two sides stay distinguishable instead of both converging on
    // the overall mean. A cell can be in both a horizontal and a vertical band —
    // they're independent projections of the same grid, not a partition.
    const EDGE_BAND = 6;

    // Reduce an RGBA buffer to a color, optionally with per-edge colors for the
    // directional gradient. Skips fully transparent cells; returns null bg when
    // nothing opaque was found.
    //
    // The edge colors are the whole point of sampling into a grid rather than
    // reading one pixel: the spatial information is already here, and the old code
    // averaged it away. Computing them is one extra accumulate per cell inside the
    // loop we were running anyway.
    function reduceGrid(img, grid, asLight, wantEdges) {
      // Each bucket is [r, g, b, weight].
      const all = [0, 0, 0, 0];
      const left = [0, 0, 0, 0];
      const right = [0, 0, 0, 0];
      const top = [0, 0, 0, 0];
      const bottom = [0, 0, 0, 0];

      const add = (bucket, r, g, b, w) => {
        bucket[0] += r; bucket[1] += g; bucket[2] += b; bucket[3] += w;
      };
      const finish = (bucket) => {
        const w = bucket[3];
        if (w === 0) return null;
        if (!asLight) return `rgb(${(bucket[0] / w) | 0}, ${(bucket[1] / w) | 0}, ${(bucket[2] / w) | 0})`;
        return `rgb(${linearToSrgb8(bucket[0] / w)}, ${linearToSrgb8(bucket[1] / w)}, ${linearToSrgb8(bucket[2] / w)})`;
      };

      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          const off = (y * grid + x) * 4;
          if (img[off + 3] === 0) continue;
          const R = img[off], G = img[off + 1], B = img[off + 2];
          let r, g, b, w;
          if (asLight) {
            const max = R > G ? (R > B ? R : B) : (G > B ? G : B);
            const min = R < G ? (R < B ? R : B) : (G < B ? G : B);
            w = 1 + CHROMA_WEIGHT * ((max - min) / 255);
            r = SRGB_TO_LINEAR[R] * w; g = SRGB_TO_LINEAR[G] * w; b = SRGB_TO_LINEAR[B] * w;
          } else {
            w = 1; r = R; g = G; b = B;
          }
          add(all, r, g, b, w);
          if (wantEdges) {
            if (x < EDGE_BAND) add(left, r, g, b, w);
            if (x >= grid - EDGE_BAND) add(right, r, g, b, w);
            if (y < EDGE_BAND) add(top, r, g, b, w);
            if (y >= grid - EDGE_BAND) add(bottom, r, g, b, w);
          }
        }
      }

      const bg = finish(all);
      if (!bg || !wantEdges) return { bg, edges: null };
      const l = finish(left), r2 = finish(right), t = finish(top), b2 = finish(bottom);
      // Partial edge data would render as a gradient with missing stops, so treat
      // all-or-nothing: any missing band drops the whole set and we tint flat.
      const edges = (l && r2 && t && b2) ? { l, r: r2, t, b: b2 } : null;
      return { bg, edges };
    }

    // ============================================================
    // Persistent singleton — process-lifetime, installed once.
    // ============================================================
    const singleton = {
      // Config, updated by the chrome side's config message. Persisted here so a
      // per-document reload can re-apply it without waiting for a new message.
      // ytAmbient defaults true (matching the pref default) so the feature still
      // works if a config message is ever dropped; a delivered message is
      // authoritative either way.
      config: {
        liveRateMs: 0, alwaysOn: false, threshold: 0, debug: false,
        ytAmbient: true, lightAverage: false,
        // Which color to sample. 'page-background' = the page's own declared
        // background (body → html → clear); 'content' = the painted-pixel chain.
        // Defaults to page-background so a dropped config message leaves the
        // DEFAULT behavior in effect rather than the older one.
        colorSource: 'page-background',
        // Compute per-edge colors? Off unless the chrome side has a non-zero
        // ambient spread, so the regional accumulate is skipped when unused.
        edges: false,
        // Sample a color for the drawn outline from the page's own pixels? This
        // is INDEPENDENT of the tint source: the tint can follow the declared
        // background while the outline still reads the page's visible colors.
        // Off when the outline is switched off, which is what keeps the declared
        // path's "two computed styles, no compositor read" promise whenever the
        // outline is not drawing. Defaults true to match the pref default.
        outline: true,
      },
      instance: null,
      configListener: null,
      teardownListener: null,

      reload() {
        if (this.instance) { try { this.instance.dispose(); } catch {} }
        this.instance = createInstance();
        this.instance.start();
        this.instance.applyConfig();
        // Ask chrome to (re)push config. Cheap, idempotent, and the only thing
        // that makes delivery deterministic on a first load — see
        // READY_MESSAGE_NAME. Config already stored on the singleton stays in
        // effect meanwhile, so this is a repair path, not the primary one.
        try { sendAsyncMessage(READY_MESSAGE_NAME, {}); } catch (e) {}
        if (this.config.debug) {
          try {
            console.log('[zen-tint frame] instance started | ytAmbient =', this.config.ytAmbient,
              '| lightAverage =', this.config.lightAverage,
              '| colorSource =', this.config.colorSource,
              '| outline =', this.config.outline,
              '| liveRateMs =', this.config.liveRateMs);
          } catch {}
        }
      },

      // The subset of the config that changes WHAT a sample yields, as opposed to
      // how often we poll. If one of these changes, the color already on screen
      // was produced by different rules, so it has to be redone.
      sampleSignature(cfg) {
        return `${cfg.colorSource}|${cfg.ytAmbient}|${cfg.lightAverage}|${cfg.edges}|${cfg.outline}`;
      },

      applyConfig(data) {
        const before = this.sampleSignature(this.config);
        this.config = {
          liveRateMs: data && data.liveRateMs > 0 ? data.liveRateMs : 0,
          alwaysOn: !!(data && data.alwaysOn),
          threshold: data && data.threshold > 0 ? data.threshold : 0,
          debug: !!(data && data.debug),
          ytAmbient: !!(data && data.ytAmbient),
          lightAverage: !!(data && data.lightAverage),
          // Only the exact known value is honored; anything else falls back to
          // the default, so a partial or malformed config message can't select
          // a mode this script doesn't implement.
          colorSource: (data && data.colorSource === 'content') ? 'content' : 'page-background',
          edges: !!(data && data.edges),
          outline: !!(data && data.outline),
        };
        if (this.instance) {
          this.instance.applyConfig();
          // Re-sample when the config changed what a sample yields. The chrome
          // side can't do this for us: the source decision lives in this
          // process, and the config message only carries the new settings.
          // Without it the new source would take effect on the next mutation,
          // poll tick, or tab switch — and on a static page with no video, none
          // of those may ever happen, so the chrome would keep showing the
          // color produced by the OLD source indefinitely.
          if (this.sampleSignature(this.config) !== before) {
            try { this.instance.sample(true); } catch {}
          }
        }
      },

      teardown() {
        if (this.instance) { try { this.instance.dispose(); } catch {} this.instance = null; }
        try { removeMessageListener(CONFIG_MESSAGE_NAME, this.configListener); } catch {}
        try { removeMessageListener(TEARDOWN_MESSAGE_NAME, this.teardownListener); } catch {}
        globalThis.__zenPageTint = null;
      },
    };

    // ============================================================
    // Per-document instance factory.
    // ============================================================
    function createInstance() {
      const inst = {
        alive: true,
        // dirty: a theme-affecting change happened while the tab was hidden, so a
        // resample is owed on next foreground (background tabs never drawWindow).
        dirty: false,
        lastBg: null,
        lastRescheduleAt: 0,
        observers: [],
        cleanups: [],          // listener removers, run on dispose
        // live state
        liveTimer: null,
        liveAlwaysOn: false,
        liveRateMs: 0,
        liveVideoIsPlaying: false,
        liveVisibilityWired: false,
        liveVideoListenersWired: false,
      };

      // Register an event listener and remember how to remove it.
      function on(target, type, handler, opts) {
        try { target.addEventListener(type, handler, opts); } catch {}
        inst.cleanups.push(() => { try { target.removeEventListener(type, handler, opts); } catch {} });
      }

      // ---- Canvas (shared for pixel sampling AND color normalization) ----
      let canvas = null;
      let ctx = null;
      function ensureCanvas() {
        if (ctx) return true;
        try {
          canvas = content.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
          canvas.width = PIXEL_SAMPLE_GRID;
          canvas.height = PIXEL_SAMPLE_GRID;
          // willReadFrequently keeps the canvas in software memory so the
          // drawWindow→getImageData readback on every sample isn't a GPU stall.
          ctx = canvas.getContext('2d', { willReadFrequently: true });
          return !!ctx;
        } catch (e) { canvas = null; ctx = null; return false; }
      }

      // ---- YouTube ambient state ----
      // The ambient read shares the canvas above. An earlier version drew YouTube's
      // #cinematics canvas into a SEPARATE one, because a CORS-tainted source taints
      // its destination permanently and would have taken readPixel() and
      // normalizeColor() down with it. That turned out to be exactly what happens —
      // so the canvas-reading approach is gone, and drawWindow (privileged, never
      // taints) needs no second buffer.
      //
      // Set only if drawWindow turns out to be missing, so we stop retrying a call
      // that cannot start working.
      let ambientBlocked = false;
      // Ambient debug logging fires on STATE CHANGE, not once per document and not
      // once per poll tick. Once-per-document logged only the pre-playback sample
      // (where there is legitimately nothing to read) and then went silent, which
      // read as "selector is wrong" when it meant "nothing is playing";
      // once-per-tick at 4 Hz buries the console.
      let ambientLogKey = '';

      // Host gate, resolved once per document: readYouTubeAmbient() does DOM
      // lookups on every sample, so it must not run off YouTube. Covers
      // www./m./music.youtube.com. Cross-origin youtube-nocookie embeds live in
      // their own browsing context we can't reach anyway.
      let isYouTube = false;
      try {
        const host = (content.location && content.location.hostname || '').toLowerCase();
        isYouTube = host === 'youtube.com' || host.endsWith('.youtube.com');
      } catch (e) {}

      // Normalize any CSS color string to canonical `rgb(r, g, b)` via the canvas
      // 2D parser (handles hex, hsl, named, color(), oklch, lab, …). Returns null
      // for invalid input or fully-transparent values. Resets the transform first
      // so a leaked transform from a thrown drawWindow can't corrupt the fillRect.
      function normalizeColor(c) {
        if (!c || typeof c !== 'string') return null;
        const trimmed = c.trim();
        if (!trimmed) return null;
        if (!ensureCanvas()) return null;
        try {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, 1, 1);
          // Setting fillStyle to an invalid string is a no-op (keeps previous value),
          // so reset to a known sentinel first to detect parse failure.
          ctx.fillStyle = 'rgba(0, 0, 0, 0)';
          ctx.fillStyle = trimmed;
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          if (d[3] === 0) return null; // transparent → treat as no color
          return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
        } catch (e) { return null; }
      }

      // Sample a wide central region, downsample into the grid, average non-
      // transparent cells. Uses setTransform (not save/scale/restore) so that if
      // drawWindow throws, the next call still starts from a clean identity
      // transform instead of inheriting a leaked scale that breaks all sampling.
      function readPixel() {
        if (!ensureCanvas()) return null;
        try {
          const w = content.innerWidth | 0;
          const h = content.innerHeight | 0;
          if (w <= 0 || h <= 0) return null;
          if (!ctx.drawWindow) return null;

          const sw = Math.max(8, (w * PIXEL_SAMPLE_FRACTION) | 0);
          const sh = Math.max(8, (h * PIXEL_SAMPLE_FRACTION) | 0);
          const sx = ((w - sw) / 2) | 0;
          const sy = ((h - sh) / 2) | 0;

          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, PIXEL_SAMPLE_GRID, PIXEL_SAMPLE_GRID);
          ctx.setTransform(PIXEL_SAMPLE_GRID / sw, 0, 0, PIXEL_SAMPLE_GRID / sh, 0, 0);
          ctx.drawWindow(content, sx, sy, sw, sh, 'rgba(0, 0, 0, 0)');
          ctx.setTransform(1, 0, 0, 1, 0, 0);

          const img = ctx.getImageData(0, 0, PIXEL_SAMPLE_GRID, PIXEL_SAMPLE_GRID).data;
          // Page samples default to the flat mean; the light model is opt-in.
          return reduceGrid(img, PIXEL_SAMPLE_GRID, singleton.config.lightAverage, singleton.config.edges);
        } catch (e) {
          try { ctx.setTransform(1, 0, 0, 1, 0, 0); } catch {}
          return null;
        }
      }

      // ---- The outline's color, from the page's own visible pixels ----
      //
      // ZPT-023. The outline is drawn ON the page, so the color that reads best
      // is one the page actually contains: the line belongs to the page and
      // cannot disagree with what is on screen. The favicon (the chrome side's
      // fallback) answers a different question — "what is this site's brand?" —
      // which is often wrong here: a monochrome logo gives nothing, a
      // multi-brand host gives another brand's color, and a logo's color need
      // not be painted anywhere on the page.
      //
      // This is a SEPARATE read from readPixel() on purpose. readPixel() answers
      // "what color is the page" by averaging, and an average is exactly the
      // wrong answer for a line that must be visible AGAINST the page: it would
      // come back as the page's own background and vanish into it. This read
      // counts cells by hue family instead and ignores anything close to the
      // background.
      let outlineCanvas = null;
      let outlineCtx = null;
      function ensureOutlineCanvas() {
        if (outlineCtx) return true;
        try {
          outlineCanvas = content.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
          outlineCanvas.width = OUTLINE_SAMPLE_GRID;
          outlineCanvas.height = OUTLINE_SAMPLE_GRID;
          // Same reason as the tint canvas: this buffer is read back on every
          // sample, so keep it in software memory instead of stalling the GPU.
          outlineCtx = outlineCanvas.getContext('2d', { willReadFrequently: true });
          return !!outlineCtx;
        } catch (e) { outlineCanvas = null; outlineCtx = null; return false; }
      }

      // Count the grid's cells by hue family and take the biggest chromatic one.
      // `bg` is our canonical rgb() string for the page's own background, used
      // for the two exclusion rules: a cell that IS the background never counts,
      // and the winner is pushed to a lightness that reads against it.
      function extractOutlineColor(img, bg) {
        const bgRgb = parseRgbTriplet(bg);
        const families = Array.from({ length: 12 }, () => ({ n: 0, r: 0, g: 0, b: 0 }));
        for (let i = 0; i < img.length; i += 4) {
          if (img[i + 3] === 0) continue;
          const r = img[i], g = img[i + 1], b = img[i + 2];
          const hsl = rgbToHsl(r, g, b);
          if (hsl.s < OUTLINE_MIN_SATURATION) continue;   // grey, not a colour
          if (hsl.l < 0.12 || hsl.l > 0.92) continue;     // near-black / white
          if (bgRgb && Math.max(
            Math.abs(r - bgRgb.r), Math.abs(g - bgRgb.g), Math.abs(b - bgRgb.b),
          ) < OUTLINE_BG_DISTANCE) continue;              // this IS the background
          // 12 families of 30°, shifted so pure red sits in the middle of one
          // (the same bucketing the chrome side uses for the favicon fallback).
          const f = families[Math.floor(((hsl.h * 360 + 15) % 360) / 30)];
          f.n++; f.r += r; f.g += g; f.b += b;
        }

        // Most common family wins. No dominance ratio: unlike the favicon (where
        // several exact shades compete inside one logo), the families here are
        // regions of the page, and the most common one is the answer even when
        // the runner-up is close.
        let best = null;
        for (const f of families) {
          if (f.n >= OUTLINE_MIN_CELLS && (!best || f.n > best.n)) best = f;
        }
        if (!best) return null;

        const base = rgbToHsl(best.r / best.n, best.g / best.n, best.b / best.n);
        const bgL = bgRgb ? rgbToHsl(bgRgb.r, bgRgb.g, bgRgb.b).l : 0.5;
        // Visibility against the page it is drawn on: stay at least ~0.22
        // lightness away from the background, in whichever direction the color
        // already leans, so the hue survives. Saturation gets the same floor the
        // favicon path uses — a washed-out line reads as a grey rule.
        const l = bgL >= 0.5
          ? Math.max(0.18, Math.min(base.l, bgL - 0.22))
          : Math.min(0.88, Math.max(base.l, bgL + 0.22));
        const s = Math.max(base.s, 0.45);
        const out = hslToRgb(base.h, s, l);
        return `rgb(${out.r}, ${out.g}, ${out.b})`;
      }

      // Draw the whole viewport into the outline grid and pick from it. The whole
      // viewport (not readPixel's central 60%) because the outline frames the
      // whole page — a color at the edge is as much a page color as one in the
      // middle. Canvas smoothing is deliberately LEFT ON: each cell is then an
      // average of its patch, so thin text and anti-aliasing fringes dissolve
      // instead of registering as a color, while a solid area keeps its hue.
      //
      // Under the content source this is a SECOND draw (readPixel already drew
      // its own grid). That path is opt-in and already paid for a compositor
      // read; duplicating the buffer bookkeeping to save it would couple the two
      // reductions, which are deliberately different questions.
      function readOutlineColor(bg) {
        if (!bg) return null;   // no tint means no outline; skip the draw entirely
        if (!ensureOutlineCanvas()) return null;
        try {
          const w = content.innerWidth | 0;
          const h = content.innerHeight | 0;
          if (w <= 0 || h <= 0) return null;
          if (!outlineCtx.drawWindow) return null;
          const G = OUTLINE_SAMPLE_GRID;
          outlineCtx.setTransform(1, 0, 0, 1, 0, 0);
          outlineCtx.clearRect(0, 0, G, G);
          outlineCtx.setTransform(G / w, 0, 0, G / h, 0, 0);
          outlineCtx.drawWindow(content, 0, 0, w, h, 'rgba(0, 0, 0, 0)');
          outlineCtx.setTransform(1, 0, 0, 1, 0, 0);
          const img = outlineCtx.getImageData(0, 0, G, G).data;
          return extractOutlineColor(img, bg);
        } catch (e) {
          try { outlineCtx.setTransform(1, 0, 0, 1, 0, 0); } catch {}
          return null;
        }
      }

      // Read the YouTube ambient-mode color.
      //
      // WHY NOT THE CANVAS ITSELF: ambient mode paints downscaled video frames into
      // canvases under #cinematics (two of them, 110x75, cross-faded) and CSS-blurs
      // them into the glow around the player. Reading those directly is the obvious
      // approach and it does not work: YouTube's video is served cross-origin from
      // googlevideo.com without CORS, so the moment a frame lands the canvas is
      // origin-tainted. YouTube can display it; nobody can read it back.
      // getImageData throws SecurityError, verified in the wild — the canvas reads
      // fine while blank, then dies exactly when playback starts.
      //
      // WHAT WE DO INSTEAD: drawWindow the painted picture box of the <video>
      // element. drawWindow is the privileged compositor read the main pixel path
      // already relies on, so tainting simply does not apply. The colors are the
      // same source data ambient mode is built from — it's a copy of these frames —
      // and scoping to the video's own box keeps out everything a centered viewport
      // grab drags in: comments, the recommendations column, the player chrome.
      //
      // Letterboxing is handled better here than the canvas could have. The <video>
      // box is sized to the player, so a 21:9 video inside it is bordered by black
      // bars sitting right where the centered read looks. Deriving the picture box
      // from videoWidth/videoHeight excludes them geometrically.
      //
      // Still gated on #cinematics existing, so this tracks YouTube's own Ambient
      // mode toggle: switch it off and the tint falls back to the normal chain.
      function readYouTubeAmbient() {
        if (ambientBlocked || !ensureCanvas()) return null;
        try {
          const doc = content.document;
          if (!ctx.drawWindow) { ambientBlocked = true; return null; }

          const container = doc.getElementById('cinematics');
          const video = doc.querySelector('#movie_player video') || doc.querySelector('video');

          if (singleton.config.debug) {
            try {
              // Report the pieces separately — "#cinematics ABSENT" means Ambient
              // mode is off (or YouTube renamed it) while "present, no video box"
              // means it's on but nothing is painted yet. Different fixes, so don't
              // collapse them. Keyed so this logs on change, not every poll tick.
              const key = `${!!container}:${!!video}:${inst.liveVideoIsPlaying}`;
              if (key !== ambientLogKey) {
                ambientLogKey = key;
                console.log('[zen-tint frame] youtube ambient: #cinematics',
                  container ? 'present' : 'ABSENT',
                  '| <video>', video ? 'found' : 'missing',
                  '| playing:', inst.liveVideoIsPlaying);
              }
            } catch {}
          }

          if (!container || !video) return null;

          const vw = video.videoWidth | 0;
          const vh = video.videoHeight | 0;
          if (vw <= 0 || vh <= 0) return null; // no frame decoded yet

          const rect = video.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;

          // Picture box inside the element box: the video is letterboxed or
          // pillarboxed to preserve aspect, and those bars are not content.
          const scale = Math.min(rect.width / vw, rect.height / vh);
          const pw = vw * scale;
          const ph = vh * scale;
          // Trim the outer 4%: edge rows carry compression ringing, and the player
          // rounds its corners, so the extreme border is not representative.
          const inset = Math.min(pw, ph) * 0.04;
          let sx = Math.round(rect.left + (rect.width - pw) / 2 + inset);
          let sy = Math.round(rect.top + (rect.height - ph) / 2 + inset);
          let sw = Math.round(pw - inset * 2);
          let sh = Math.round(ph - inset * 2);

          // Clip to the viewport — drawWindow reads what's composited, so a
          // scrolled-away player has nothing to give. Bail rather than sample a
          // sliver; the normal chain takes over.
          const vpw = content.innerWidth | 0;
          const vph = content.innerHeight | 0;
          if (sx < 0) { sw += sx; sx = 0; }
          if (sy < 0) { sh += sy; sy = 0; }
          if (sx + sw > vpw) sw = vpw - sx;
          if (sy + sh > vph) sh = vph - sy;
          if (sw < 8 || sh < 8) return null;

          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, PIXEL_SAMPLE_GRID, PIXEL_SAMPLE_GRID);
          ctx.setTransform(PIXEL_SAMPLE_GRID / sw, 0, 0, PIXEL_SAMPLE_GRID / sh, 0, 0);
          ctx.drawWindow(content, sx, sy, sw, sh, 'rgba(0, 0, 0, 0)');
          ctx.setTransform(1, 0, 0, 1, 0, 0);

          // Always the light model regardless of the page-sample pref: this path is
          // modelling light coming off a screen, which is the whole point.
          const img = ctx.getImageData(0, 0, PIXEL_SAMPLE_GRID, PIXEL_SAMPLE_GRID).data;
          return reduceGrid(img, PIXEL_SAMPLE_GRID, true, singleton.config.edges);
        } catch (e) {
          try { ctx.setTransform(1, 0, 0, 1, 0, 0); } catch {}
          if (singleton.config.debug) {
            try { console.log('[zen-tint frame] youtube ambient read failed:', e && e.name); } catch {}
          }
          return null;
        }
      }

      // Pick the active <meta name="theme-color"> respecting `media` attributes.
      function pickMetaThemeColor(doc) {
        const metas = doc.querySelectorAll('meta[name="theme-color"]');
        if (!metas.length) return null;
        let fallback = null;
        for (const m of metas) {
          const value = m.getAttribute('content');
          if (!value) continue;
          const media = m.getAttribute('media');
          if (!media) { if (!fallback) fallback = value; continue; }
          try { if (content.matchMedia(media).matches) return value; }
          catch (e) { /* malformed media query — skip */ }
        }
        return fallback;
      }

      // Read the page's DECLARED background: the color the page itself says it
      // sits on, independent of what is painted on top of it.
      //
      // WHY A SEPARATE SOURCE: the pixel path samples what is VISIBLE, which is
      // what you want for video and for apps that lie about their background. But
      // it also means the chrome is tinted by "whatever the content averages to"
      // rather than by the page's own background — on a site whose content is a
      // mix of cards, text and imagery, that average isn't the page color at all.
      // This source answers the other question: what color does the page declare?
      //
      // body → html → nothing. A transparent body/html is a legitimate answer
      // ("this page has no background of its own"), so it resolves to null and
      // the chrome clears the tint back to Zen's theme rather than inventing a
      // color. Sites that paint their background on a wrapper element land here
      // too — a known, accepted limitation.
      //
      // No DOM walk, no drawWindow, no <meta name="theme-color">: this path
      // answers one question only, and every extra source would reintroduce the
      // "which color is really the page's" ambiguity it exists to remove.
      function readDeclaredBackground(doc) {
        if (doc.body) {
          const c = normalizeColor(content.getComputedStyle(doc.body).backgroundColor);
          if (c) return { bg: c, source: 'page-bg:body' };
        }
        if (doc.documentElement) {
          const c = normalizeColor(content.getComputedStyle(doc.documentElement).backgroundColor);
          if (c) return { bg: c, source: 'page-bg:html' };
        }
        return { bg: null, source: 'page-bg:none' };
      }

      // Sample chain (first match wins): yt-ambient → pixel → meta → body → html
      // → walk. Every path is normalized so the chrome side only sees rgb(r, g, b).
      //
      // Only the two grid-based paths can produce `edges` (directional colors for
      // the ambient gradient) — a computed-style or meta color is a single value
      // with no spatial content. Those paths leave edges null and the chrome tints
      // flat, which is correct: there's no gradient to infer from one color.
      function read() {
        try {
          // The page-background source is a different question, not another step
          // in this chain, so it short-circuits the whole thing. Nothing below
          // (yt-ambient, pixel, meta, body/html, walk) may run under it.
          if (singleton.config.colorSource === 'page-background') {
            const declared = readDeclaredBackground(content.document);
            // The outline is sampled from the PIXELS even under the declared
            // source. The two questions are independent: the tint asks what the
            // page DECLARES, the outline asks what the page LOOKS like. This is
            // the one compositor read the declared path makes, and it is skipped
            // entirely when the outline is switched off (config.outline).
            return {
              bg: declared.bg,
              edges: null,
              outlineColor: singleton.config.outline ? readOutlineColor(declared.bg) : null,
              source: declared.source,
            };
          }

          const doc = content.document;
          let bg = null;
          let edges = null;
          let source = '';

          // YouTube with Ambient mode on: read the video's own picture box instead
          // of a centered viewport grab. Host-gated so no other site pays the probe.
          if (singleton.config.ytAmbient && isYouTube) {
            const ambient = readYouTubeAmbient();
            if (ambient && ambient.bg) { bg = ambient.bg; edges = ambient.edges; source = 'yt-ambient'; }
          }

          if (!bg) {
            const pixel = readPixel();
            if (pixel && pixel.bg) { bg = pixel.bg; edges = pixel.edges; source = 'pixel'; }
          }

          if (!bg) {
            const metaValue = pickMetaThemeColor(doc);
            const normalized = metaValue ? normalizeColor(metaValue) : null;
            if (normalized) { bg = normalized; source = 'meta'; }
          }

          if (!bg && doc.body) {
            const c = normalizeColor(content.getComputedStyle(doc.body).backgroundColor);
            if (c) { bg = c; source = 'body'; }
          }

          if (!bg && doc.documentElement) {
            const c = normalizeColor(content.getComputedStyle(doc.documentElement).backgroundColor);
            if (c) { bg = c; source = 'html'; }
          }

          if (!bg && doc.body) {
            try {
              const w = content.innerWidth | 0;
              const h = content.innerHeight | 0;
              if (w > 0 && h > 0) {
                let cur = doc.elementFromPoint((w / 2) | 0, (h / 2) | 0);
                let steps = 0;
                while (cur && steps < 12) {
                  const c = normalizeColor(content.getComputedStyle(cur).backgroundColor);
                  if (c) { bg = c; source = 'walk:' + (cur.tagName || '?').toLowerCase(); break; }
                  cur = cur.parentElement;
                  steps++;
                }
              }
            } catch (e) {}
          }

          // Same independent question as under the declared source: the tint
          // follows the content, the outline follows a color found on the page.
          const outlineColor = singleton.config.outline ? readOutlineColor(bg) : null;
          return { bg, edges, outlineColor, source };
        } catch (e) {
          return { bg: null, edges: null, outlineColor: null, source: 'error' };
        }
      }

      // Parse our own canonical `rgb(r, g, b)` strings back to a triplet.
      function parseRgbTriplet(s) {
        if (typeof s !== 'string') return null;
        const m = s.match(/(\d+)\D+(\d+)\D+(\d+)/);
        return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
      }

      function maxChannelDelta(a, b) {
        const pa = parseRgbTriplet(a);
        const pb = parseRgbTriplet(b);
        if (!pa || !pb) return null;
        return Math.max(Math.abs(pa.r - pb.r), Math.abs(pa.g - pb.g), Math.abs(pa.b - pb.b));
      }

      // Different enough from the last sent color to be worth applying?
      function significantChange(newBg) {
        if (newBg === inst.lastBg) return false;
        if (inst.lastBg === null || newBg === null) return true;
        const th = singleton.config.threshold;
        if (th <= 0) return true;
        const d = maxChannelDelta(newBg, inst.lastBg);
        return d === null ? true : d >= th;
      }

      // Returns true iff it actually sent an update. `allowNull` lets callers
      // suppress sending a null (no-color) result during the pre-paint window so
      // we don't flash-clear the tint before the page has painted; later samples
      // (load/pageshow reschedule) re-evaluate and CAN send null to clear a
      // genuinely colorless page.
      function sample(force, allowNull = true) {
        if (!inst.alive) return false;
        const r = read();
        if (r.bg === null && !allowNull) return false;
        if (!(force || significantChange(r.bg))) return false;
        inst.lastBg = r.bg;
        try {
          sendAsyncMessage(MESSAGE_NAME, {
            bg: r.bg,
            // Directional colors for the ambient gradient, or null. The threshold
            // check above deliberately looks at bg only: it's the dominant color and
            // the edges move with it, so gating on both would fire far more often
            // for a change nobody can see.
            edges: r.edges,
            // The outline's color, picked from the page's own pixels — null means
            // "no usable color on this page", and the chrome falls back to the
            // site's favicon. Sent with the same sample so a cache hit restores
            // both, with no second round trip.
            outlineColor: r.outlineColor || null,
            source: r.source,
            href: content.location && content.location.href,
          });
        } catch (e) { /* content torn down mid-send */ }
        return true;
      }

      function debounce(fn, ms) {
        let timer = null;
        return () => {
          if (timer) return;
          timer = content.setTimeout(() => { timer = null; if (inst.alive) fn(); }, ms);
        };
      }
      const debouncedSample = debounce(() => sample(false), SAMPLE_DEBOUNCE_MS);

      // ---- Live mode (fixed-rate poll loop) ----
      function shouldPollNow() {
        const doc = content.document;
        return !!doc
          && inst.liveRateMs > 0
          && doc.visibilityState === 'visible'
          && (inst.liveAlwaysOn || inst.liveVideoIsPlaying);
      }
      function stopPolling() {
        if (inst.liveTimer) { try { content.clearTimeout(inst.liveTimer); } catch {} inst.liveTimer = null; }
      }
      // One rate, the configured one. Whether a tick actually re-tints is decided
      // by the threshold in significantChange(), which is the right lever for
      // "don't churn on imperceptible jitter" — cadence and sensitivity stay
      // independent knobs instead of one silently driving the other.
      function scheduleNextPoll() {
        inst.liveTimer = content.setTimeout(livePollTick, inst.liveRateMs);
      }
      function livePollTick() {
        inst.liveTimer = null;
        if (!inst.alive || !shouldPollNow()) return;
        sample(false);
        scheduleNextPoll();
      }
      function updatePollingState() {
        if (shouldPollNow()) { if (!inst.liveTimer) scheduleNextPoll(); }
        else stopPolling();
      }

      function checkVideoState() {
        const doc = content.document;
        if (!doc) { if (inst.liveVideoIsPlaying) { inst.liveVideoIsPlaying = false; updatePollingState(); } return; }
        let anyPlaying = false;
        try {
          for (const v of doc.querySelectorAll('video')) {
            if (!v.paused && !v.ended && v.readyState >= 2) { anyPlaying = true; break; }
          }
        } catch {}
        if (inst.liveVideoIsPlaying !== anyPlaying) { inst.liveVideoIsPlaying = anyPlaying; updatePollingState(); }
      }
      const scheduleVideoCheck = debounce(checkVideoState, VIDEO_CHECK_DEBOUNCE_MS);

      function wireVideoDetection() {
        if (inst.liveVideoListenersWired) { checkVideoState(); return; }
        inst.liveVideoListenersWired = true;
        const doc = content.document;
        // Capture-phase document listeners catch media events from any <video>,
        // including dynamically-inserted players. (Cross-origin <iframe> embeds
        // are invisible here — use the host allowlist for those.)
        for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied', 'abort']) {
          on(doc, ev, scheduleVideoCheck, { capture: true });
        }
        checkVideoState();
      }

      function wireVisibilityListener() {
        if (inst.liveVisibilityWired) return;
        inst.liveVisibilityWired = true;
        on(content.document, 'visibilitychange', () => {
          if (content.document.visibilityState === 'visible') {
            // Only resample if something actually changed while hidden — the chrome
            // side already restored the cached color on tab select, so an
            // unconditional forced sample here would be redundant IPC + restyle.
            if (inst.dirty) { inst.dirty = false; sample(true); }
            if (!inst.liveAlwaysOn && inst.liveVideoListenersWired) checkVideoState();
          }
          updatePollingState();
        });
      }

      // Re-evaluate live mode against the current persistent config.
      function applyConfig() {
        const cfg = singleton.config;
        inst.liveRateMs = cfg.liveRateMs > 0 ? Math.max(LIVE_RATE_FLOOR_MS, cfg.liveRateMs) : 0;
        inst.liveAlwaysOn = !!cfg.alwaysOn;
        wireVisibilityListener();
        if (!inst.liveAlwaysOn && inst.liveRateMs > 0) wireVideoDetection();
        updatePollingState();
      }

      // Mutation observers. Background-tab mutations only mark dirty (no drawWindow);
      // a foreground change debounces a sample. Head <title> churn is ignored.
      function attachObservers(doc) {
        if (inst.observers.length) return; // idempotent: both tryAttach paths can call this
        const onMutation = () => {
          if (content.document.visibilityState !== 'visible') { inst.dirty = true; return; }
          debouncedSample();
        };
        const mo = new content.MutationObserver(onMutation);
        const opts = { attributes: true, attributeFilter: THEME_ATTRS };
        try { mo.observe(doc.documentElement, opts); } catch {}
        if (doc.body) { try { mo.observe(doc.body, opts); } catch {} }
        inst.observers.push(mo);

        if (doc.head) {
          const onHeadMutation = (records) => {
            if (content.document.visibilityState !== 'visible') { inst.dirty = true; return; }
            for (const r of records) {
              const t = r.target;
              const nn = (t && t.nodeName || '').toLowerCase();
              const pn = (t && t.parentNode && t.parentNode.nodeName || '').toLowerCase();
              if (nn === 'title' || pn === 'title') continue; // title text can't affect bg
              debouncedSample();
              return;
            }
          };
          const ho = new content.MutationObserver(onHeadMutation);
          try {
            ho.observe(doc.head, {
              childList: true, subtree: true, characterData: true,
              attributes: true, attributeFilter: ['href', 'content', 'media', 'disabled'],
            });
          } catch {}
          inst.observers.push(ho);
        }
      }

      // Attach observers once the document has a body. Body-less documents (raw
      // SVG/XML/RSS) never get one, so retry is bounded — observe documentElement
      // and give up instead of looping a 150ms timer forever.
      function startObserving() {
        const doc = content.document;
        if (doc.body) { attachObservers(doc); return; }
        let tries = 0;
        const tryAttach = () => {
          if (!inst.alive) return;
          if (doc.body || ++tries > 20) { attachObservers(doc); return; } // ~3s cap
          content.setTimeout(tryAttach, 150);
        };
        on(doc, 'DOMContentLoaded', tryAttach, { once: true, capture: true });
        content.setTimeout(tryAttach, 150);
      }

      function start() {
        // Initial sample — wait for DOMContentLoaded if still loading, so we don't
        // read a half-rendered loading screen. Suppress null at that pre-paint
        // moment (load/pageshow reschedules below handle a genuinely colorless page).
        if (content.document.readyState === 'loading') {
          on(content.document, 'DOMContentLoaded', () => sample(true, false), { once: true, capture: true });
        } else {
          sample(true, true);
        }

        startObserving();

        // Re-sample after load. 300ms catches quick theme application; 2000ms
        // catches slow bootstrappers (Gmail dark mode). Coalesced within 500ms
        // because both load and pageshow fire on a fresh navigation.
        const reschedule = () => {
          const now = Date.now();
          if (now - inst.lastRescheduleAt < 500) return;
          inst.lastRescheduleAt = now;
          content.setTimeout(() => sample(true), 300);
          content.setTimeout(() => sample(true), 2000);
        };
        // No capture: a capture-phase window listener would fire for every
        // subresource (<img>/<script>/<iframe>) load, hammering drawWindow on
        // image-heavy feeds. Without capture only the top-level load reaches us.
        on(content, 'load', reschedule);
        on(content, 'pageshow', reschedule);
      }

      function dispose() {
        inst.alive = false;
        stopPolling();
        for (const off of inst.cleanups) { try { off(); } catch {} }
        inst.cleanups.length = 0;
        for (const o of inst.observers) { try { o.disconnect(); } catch {} }
        inst.observers.length = 0;
        // Drop canvas refs so a torn-down document's backing buffers aren't held
        // alive by this closure until the whole instance is collected.
        canvas = null; ctx = null;
        outlineCanvas = null; outlineCtx = null;
      }

      inst.start = start;
      inst.applyConfig = applyConfig;
      // Exposed so the persistent singleton can force a re-sample when a config
      // message changes what a sample yields — see singleton.applyConfig.
      inst.sample = sample;
      inst.dispose = dispose;
      return inst;
    }

    // ---- Register persistent message listeners (object form is the reliable
    // frame-script API; the bare-function form silently no-ops in some scopes). ----
    singleton.configListener = {
      receiveMessage(msg) {
        try {
          const data = (msg && msg.data) || {};
          if (data.debug) {
            try {
              console.log('[zen-tint frame] config received, rate =', data.liveRateMs,
                '| alwaysOn =', !!data.alwaysOn, '| threshold =', data.threshold);
            } catch {}
          }
          singleton.applyConfig(data);
        } catch (e) {
          try { console.error('[zen-tint frame] config handler error:', e); } catch {}
        }
      },
    };
    singleton.teardownListener = {
      receiveMessage() {
        try { singleton.teardown(); }
        catch (e) { try { console.error('[zen-tint frame] teardown error:', e); } catch {} }
      },
    };
    try { addMessageListener(CONFIG_MESSAGE_NAME, singleton.configListener); }
    catch (e) { try { console.error('[zen-tint frame] addMessageListener failed:', e); } catch {} }
    try { addMessageListener(TEARDOWN_MESSAGE_NAME, singleton.teardownListener); } catch {}

    globalThis.__zenPageTint = singleton;
    singleton.reload();
  } catch (e) {
    try { console.error('[zen-tint frame] init failed:', e); } catch {}
  }
})();
