// ==UserScript==
// @name           Zen Tint
// @description    Zen chrome that continues the page's background color
// @version        1.4.0
// ==/UserScript==

(() => {
  'use strict';

  // Each pref is read independently: Services.prefs.get*Pref throws on a
  // wrong-TYPE pref (the default arg only covers the missing case), so sharing one
  // try block would let a single mistyped about:config entry silently revert every
  // later pref to its default.
  function prefBool(name, def) { try { return Services.prefs.getBoolPref(name, def); } catch { return def; } }
  function prefInt(name, def) { try { return Services.prefs.getIntPref(name, def); } catch { return def; } }
  function prefStr(name, def) { try { return Services.prefs.getStringPref(name, def); } catch { return def; } }

  // DEBUG is read from a pref so it can be toggled at runtime via about:config
  // (zen.page-tint.debug = true). Defaults to false.
  const DEBUG = prefBool('zen.page-tint.debug', false);
  const log = DEBUG ? (...args) => console.log('[zen-tint]', ...args) : () => {};

  // Live mode — optional continuous polling that lets the chrome tint follow
  // video / animated content in real time. On by default (auto-detected against
  // <video>, so static pages cost zero). Tunable in about:config:
  //
  //   zen.page-tint.live-mode               (bool, default true)
  //     Master switch. When off, no polling at all (pure event-driven).
  //   zen.page-tint.live-mode-rate-ms       (int, default 2000 — 0.5 Hz)
  //     The poll interval, used verbatim (floored at 100ms as a guard against an
  //     absurd value). This is the rate at which the chrome color can change.
  //     Sampling used to adaptively run at rate/4 on changing content, which meant
  //     video pinned it there permanently and this number never actually applied —
  //     see the frame script. How MUCH change is needed to re-tint is a separate
  //     knob (live-mode-threshold); this one is purely cadence.
  //   zen.page-tint.live-mode-threshold     (int, default 8 — 0..255)
  //     Minimum per-channel color change required to actually re-tint. Below this
  //     is ignored so the chrome doesn't churn. Set 0 to re-tint on any change.
  //   zen.page-tint.live-mode-smoothing-ms  (int, default 1000)
  //     CSS transition duration applied to EVERY tint change, live or event-driven.
  //   zen.page-tint.live-mode-always-on     (bool, default false)
  //     When false, live polling only runs while a <video> is actually playing.
  //   zen.page-tint.live-mode-hosts         (string, default '')
  //     Comma-separated host allowlist treated as always-on (canvas/WebGL players,
  //     cross-origin <iframe> video embeds). Matched by hostname, port-independent.
  //       example.com, *.spotify.com, music.apple.com, localhost
  //
  // Disabling the master switch requires a Zen restart (config is pushed only at
  // frame-script load time). All polling is paused when the tab is backgrounded.
  const LIVE_MODE = prefBool('zen.page-tint.live-mode', true);
  const LIVE_RATE_MS = prefInt('zen.page-tint.live-mode-rate-ms', 2000);
  const LIVE_SMOOTH_MS = prefInt('zen.page-tint.live-mode-smoothing-ms', 1000);
  const LIVE_ALWAYS_ON = prefBool('zen.page-tint.live-mode-always-on', false);
  const LIVE_HOSTS_RAW = prefStr('zen.page-tint.live-mode-hosts', '');
  const LIVE_THRESHOLD = prefInt('zen.page-tint.live-mode-threshold', 8);

  // Color-source prefs. All of them are pushed to the frame script with the rest
  // of the config, and all of them are live-applicable (the observer below clears
  // the cache and re-samples), so they can be A/B'd without a restart.
  //
  //   zen.page-tint.youtube-ambient  (bool, default true)
  //     On YouTube, sample the video's own painted picture box instead of a
  //     centered viewport grab, gated on the player's Ambient mode being on. Same
  //     frames YouTube's on-screen glow is built from, minus what a viewport grab
  //     drags in — letterbox bars on a 21:9 video, page chrome, the comments
  //     column. (It reads the compositor via drawWindow, not YouTube's own
  //     #cinematics canvas: that canvas is CORS-tainted by the cross-origin video
  //     stream and throws on read. See the frame-script comment.) With Ambient mode
  //     off we fall through to the normal sample chain.
  //   zen.page-tint.light-average    (bool, default false)
  //     Average PAGE samples as light rather than as flat color: decode sRGB to
  //     linear before averaging and weight vivid cells above gray ones. More
  //     accurate physically, and noticeably brighter/more saturated on mixed
  //     pages — a mostly-dark page with bright content on it stops reading as
  //     dark, which is why it's off by default. The YouTube ambient path always
  //     uses this model regardless, since there it's modelling actual light.
  let YT_AMBIENT = prefBool('zen.page-tint.youtube-ambient', true);
  let LIGHT_AVERAGE = prefBool('zen.page-tint.light-average', false);
  //   zen.page-tint.color-source  (string, default 'page-background')
  //     Which color the chrome follows:
  //       'page-background' — the page's own DECLARED background (body → html →
  //                           clear). Flat, and it tracks the page's surface
  //                           rather than "whatever the content averages to".
  //                           This is the default: the frame should read as a
  //                           continuation of the page, not as a sample of it.
  //       'content'         — the painted pixels. Video-aware, and it rescues
  //                           apps that lie about their background (Gmail).
  //                           Opt in when you want the chrome to follow the
  //                           content instead of the page's surface.
  //     An unrecognized value falls back to the default, so a typo in
  //     about:config can't select a half-implemented mode.
  const PAGE_BACKGROUND = 'page-background';
  const COLOR_SOURCES = ['content', PAGE_BACKGROUND];
  const DEFAULT_COLOR_SOURCE = PAGE_BACKGROUND;
  const normalizeColorSource = (v) => (COLOR_SOURCES.includes(v) ? v : DEFAULT_COLOR_SOURCE);
  let COLOR_SOURCE = normalizeColorSource(prefStr('zen.page-tint.color-source', DEFAULT_COLOR_SOURCE));

  // CSS-side appearance knobs. Unlike the live-mode prefs (read once at
  // frame-script load, so they need a restart), these only drive CSS variables,
  // so they're applied live via a pref observer below — changing them in the Sine
  // settings panel updates the chrome immediately.
  //
  //   zen.page-tint.mix-amount   (int 0..100, default 100)  → --zpt-strength
  //     Tint STRENGTH: the page color is laid as a translucent OVERLAY over Zen's
  //     own chrome (including workspace gradients) at this opacity. 100 = fully
  //     opaque page tint (the original look); 0 = no tint, your untouched Zen
  //     theme/gradient shows through; in between veils the gradient with the page
  //     color. Done as an overlay (not a solid color blend) precisely because a
  //     workspace gradient is a gradient, not a single color, so it can't be
  //     reproduced by mixing one color — see style.css --zpt-tint / the rim rule.
  //   zen.page-tint.frame-gap    (int px, default 5) → --zpt-frame-gap
  //     Non-compact only: compact mode stays flush so Zen's screen-edge hover
  //     targets remain reachable.
  //   zen.page-tint.frame-radius (int px, default 14)  → --zpt-frame-radius
  //   zen.page-tint.page-outline (bool, default true)
  //     Whether the drawn boundary is drawn at all. A drawn frame is the most
  //     opinionated thing the mod does, so it gets a real switch: the Sine panel
  //     shows a checkbox, not a number the user has to know means "off". While
  //     it is off the outline element is not even built — no DOM node, no
  //     ResizeObserver, no pixel read, no favicon lookup, no site color variable.
  //   zen.page-tint.page-outline-width (int px, default 2) → --zpt-page-outline-width
  //     The drawn boundary. A squircle stroke around the WHOLE page viewport —
  //     all four sides, continuously — in a color the page contains (sampled
  //     from its own visible pixels by frame.js), with the site's favicon as the
  //     fallback. It replaces the old frame-separator hairline, which
  //     was drawn OUTSET in the frame gap: the gap only exists on three sides
  //     (the sidebar occupies the fourth), so the line vanished on exactly the
  //     edge it was wanted on, and a flat 1px rule cannot read as a shape.
  //     Thickness only: 0 still means "off", but it is now the coarse knob next
  //     to the switch rather than the only way to say off.
  //   zen.page-tint.saturation   (int 0..200, default 100)
  //     Scales the sampled color's HSL saturation before it's applied. 0 =
  //     grayscale chrome, 100 = the page's own saturation, 200 = double (more
  //     vibrant). Adjusted in JS so the readable-foreground pick uses the result.
  //   zen.page-tint.min-lightness / .max-lightness (int 0..100, default 0 / 100)
  //     Clamp the sampled color's HSL lightness into [min, max]. Keeps blinding-
  //     white pages from washing the chrome out and near-black pages from going
  //     muddy. Defaults (0 / 100) are a no-op.
  //   zen.page-tint.disable-hosts (string, default '')
  //     Comma-separated host list (same syntax as live-mode-hosts, supports
  //     *.example.com) where the tint is turned OFF entirely — the chrome keeps
  //     your Zen theme on those sites.
  //   zen.page-tint.brightness   (int 0..300, default 100)
  //     Gain on the sampled color's lightness, applied BEFORE the min/max clamp so
  //     those stay hard bounds. 100 = untouched, 200 = twice as light. Operates on
  //     HSL lightness rather than multiplying RGB channels, so it can't shift hue
  //     or clip one channel before the others.
  //   zen.page-tint.contrast     (int 0..300, default 100)
  //     Pushes lightness away from (or toward) mid-grey: 100 = untouched, 200
  //     doubles the distance from 50%, 0 flattens everything to mid-grey. Note this
  //     acts on the single already-averaged color, so it deepens darks and lifts
  //     lights — it cannot add local contrast the way a filter on an image would.
  //   zen.page-tint.ambient-spread (int 0..100, default 0)
  //     Strength of the DIRECTIONAL gradient. The sampler already reduces the
  //     viewport to a 16x16 grid; this exposes the per-edge colors that the flat
  //     average was discarding, laid over the base tint as a gradient so the left
  //     of the chrome takes its color from the left of the page and so on. 0 = off
  //     (flat tint, exactly as before, and the frame script skips the extra work);
  //     100 = strongest. This is the analogue of the userstyle's scale + blur, done
  //     as chrome geometry instead of a GPU blur pass.
  const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, n | 0));
  let MIX_AMOUNT = clampInt(prefInt('zen.page-tint.mix-amount', 100), 0, 100);
  let SATURATION = clampInt(prefInt('zen.page-tint.saturation', 100), 0, 200);
  let MIN_LIGHT = clampInt(prefInt('zen.page-tint.min-lightness', 0), 0, 100);
  let MAX_LIGHT = clampInt(prefInt('zen.page-tint.max-lightness', 100), 0, 100);
  let BRIGHTNESS = clampInt(prefInt('zen.page-tint.brightness', 100), 0, 300);
  let CONTRAST = clampInt(prefInt('zen.page-tint.contrast', 100), 0, 300);
  let AMBIENT_SPREAD = clampInt(prefInt('zen.page-tint.ambient-spread', 0), 0, 100);
  let OUTLINE_ENABLED = prefBool('zen.page-tint.page-outline', true);
  let OUTLINE_WIDTH = clampInt(prefInt('zen.page-tint.page-outline-width', 2), 0, 8);
  // Two ways to say "off": the switch, and a width of 0. Both have to hold for
  // the outline to draw, so every consumer asks this one question instead of
  // re-deriving the pair (and drifting apart on one of the two).
  const outlineOn = () => OUTLINE_ENABLED && OUTLINE_WIDTH > 0;
  // Ceiling on the gradient overlay's alpha. Full opacity would let an edge color
  // completely replace the base tint at the extremes, which breaks the readable-
  // foreground pick (that's computed against the base). Capping keeps the endpoints
  // tethered to the base so text contrast survives at any spread.
  const EDGE_ALPHA_MAX = 0.7;

  // Host-pattern matching. Supports exact-host and leading-wildcard patterns
  // ('*.example.com' matches 'foo.example.com' but not 'example.com'). Matched
  // against URL.hostname, so entries are port-independent. Shared by the live-mode
  // allowlist and the per-site disable list.
  function parseHostList(raw) {
    return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  function hostMatches(url, patterns) {
    if (!patterns.length) return false;
    try {
      const host = new URL(url).hostname.toLowerCase();
      for (const pattern of patterns) {
        if (pattern.startsWith('*.')) { if (host.endsWith(pattern.slice(1))) return true; }
        else if (host === pattern) return true;
      }
    } catch {}
    return false;
  }
  const LIVE_HOSTS = parseHostList(LIVE_HOSTS_RAW);
  let DISABLE_HOSTS = parseHostList(prefStr('zen.page-tint.disable-hosts', ''));

  log('live-mode pref =', LIVE_MODE,
    '| rate =', LIVE_RATE_MS, 'ms',
    '| smoothing =', LIVE_SMOOTH_MS, 'ms',
    '| threshold =', LIVE_THRESHOLD,
    '| always-on =', LIVE_ALWAYS_ON,
    '| allowlist =', LIVE_HOSTS.length ? LIVE_HOSTS.join(', ') : '(none)');

  log('color-source =', COLOR_SOURCE);

  const MESSAGE_NAME = 'zen-page-tint:theme';
  const CONFIG_MESSAGE_NAME = 'zen-page-tint:config';
  const TEARDOWN_MESSAGE_NAME = 'zen-page-tint:teardown';
  // The frame script sends this once its listeners are live; we answer with
  // config. loadFrameScript() + an immediate sendConfig() races on a process's
  // first load — the message manager drops messages aimed at listeners that
  // aren't registered yet — and the failure is silent, leaving live mode off with
  // liveRateMs stuck at 0. Keeping the eager send too means the common case
  // (process already running the script) still gets config with no extra round
  // trip; this handshake only has to cover the cold start.
  const READY_MESSAGE_NAME = 'zen-page-tint:ready';
  const GLANCE_TAB_ATTRIBUTE = 'zen-glance-tab';
  const FRAME_SCRIPT_URL = 'chrome://sine/content/zen-tint/frame.js';
  const root = document.documentElement;

  // Smoothing transitions are always armed, so the smoothing variable is set
  // unconditionally.
  root.style.setProperty('--zpt-live-smoothing-ms', `${LIVE_SMOOTH_MS}ms`);

  // Tint strength / frame gap / radius are pref-driven (Sine settings panel);
  // apply at startup.
  applyCssVarPrefs();
  applyOutlineState();

  // Persistent "mod is active in this window" marker. Smoothing transitions are
  // armed against THIS attribute (not zen-page-tint) so they survive leaving a
  // tinted page for about:/chrome:. Removed only on cleanup.
  root.setAttribute('zen-page-tint-active', 'on');
  if (LIVE_MODE) root.setAttribute('zen-page-tint-live', 'on');

  function isInternalUrl(url) {
    return !url || url.startsWith('about:') || url.startsWith('chrome:');
  }

  // Cache: origin+path → bg string (canonical rgb()). Bounded LRU (true access-order).
  // Only `bg` is stored; `fg` is derived deterministically via readableFg(bg).
  const themeCache = new Map();
  // Sized above the heavy-tab working set (the project targets 1300+ tabs). A
  // smaller cap thrashes: cycling more distinct URLs than the cap forces most tab
  // switches onto the slow miss path, defeating the cache. Entries are short
  // strings (~a few hundred KB total at this size).
  const CACHE_MAX = 3000;

  function parseRgb(color) {
    if (!color) return null;
    const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  }

  // Pick black or white text for max contrast (Rec 601 luminance). The frame
  // script normalizes ALL bg values to canonical rgb() before sending.
  function readableFg(bg) {
    const rgb = parseRgb(bg);
    if (!rgb) return null;
    const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return lum > 0.55 ? '#000' : '#fff';
  }

  // ---- HSL conversion (for the saturation / lightness-clamp adjustments) ----
  // All channels 0..1.
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h, s, l };
  }
  function hslToRgb(h, s, l) {
    if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
    const hue = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Math.round(hue(p, q, h + 1 / 3) * 255),
      g: Math.round(hue(p, q, h) * 255),
      b: Math.round(hue(p, q, h - 1 / 3) * 255),
    };
  }

  // Apply saturation, brightness, contrast, then the lightness clamp to a sampled
  // color. Order matters: gain and contrast run first so the clamp stays a hard
  // bound on the final result rather than something a later multiply can escape.
  // Fast-paths out when nothing is configured (the common case) so default users
  // pay nothing.
  function transformColor(bg) {
    if (SATURATION === 100 && BRIGHTNESS === 100 && CONTRAST === 100
      && MIN_LIGHT === 0 && MAX_LIGHT === 100) return bg;
    const rgb = parseRgb(bg);
    if (!rgb) return bg;
    const unit = (n) => Math.max(0, Math.min(1, n));
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    hsl.s = unit(hsl.s * (SATURATION / 100));
    if (BRIGHTNESS !== 100) hsl.l = unit(hsl.l * (BRIGHTNESS / 100));
    if (CONTRAST !== 100) hsl.l = unit(0.5 + (hsl.l - 0.5) * (CONTRAST / 100));
    const lo = Math.min(MIN_LIGHT, MAX_LIGHT) / 100;
    const hi = Math.max(MIN_LIGHT, MAX_LIGHT) / 100;
    hsl.l = Math.max(lo, Math.min(hi, hsl.l));
    const out = hslToRgb(hsl.h, hsl.s, hsl.l);
    return `rgb(${out.r}, ${out.g}, ${out.b})`;
  }

  // Turn a transformed edge color into the translucent overlay stop CSS consumes.
  // Alpha carries the spread strength, so the compositor does the base↔edge blend
  // and JS never has to lerp — and at spread 0 the attribute gate below removes the
  // gradient rules entirely rather than painting a no-op.
  function edgeStop(color) {
    const rgb = parseRgb(color);
    if (!rgb) return null;
    const alpha = (AMBIENT_SPREAD / 100) * EDGE_ALPHA_MAX;
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha.toFixed(3)})`;
  }

  // Push the CSS-var appearance prefs into their variables, overriding the
  // stylesheet defaults. Idempotent — safe to call on every pref change.
  //   --zpt-strength is the tint OVERLAY opacity (consumed by style.css's
  //   --zpt-tint / the rim box-shadow): 100% = opaque page tint, 0% = none.
  function applyCssVarPrefs() {
    root.style.setProperty('--zpt-strength', `${MIX_AMOUNT}%`);
    root.style.setProperty('--zpt-frame-gap', `${Math.max(0, prefInt('zen.page-tint.frame-gap', 5))}px`);
    root.style.setProperty('--zpt-frame-radius', `${Math.max(0, prefInt('zen.page-tint.frame-radius', 14))}px`);
    // The outline's COLOR is derived in CSS (site color, else the tint's own
    // foreground), so only the width needs to come from here. Off = 0px, so the
    // stroke collapses even if something later forgets the attribute gate.
    root.style.setProperty('--zpt-page-outline-width', `${outlineOn() ? OUTLINE_WIDTH : 0}px`);
  }

  // ---- The drawn boundary (page outline) ----
  //
  // The tint makes the chrome continuous with the page. Taken too far, that
  // erases where the page ENDS — a sidebar and a page in the same color read as
  // one flat field. The v1.1.0 hairline tried to fix that from the chrome
  // side, but it was drawn OUTSET in the frame gap, and the gap only exists on
  // three sides (the sidebar occupies the fourth): the line rendered on the
  // top, right and bottom and vanished on exactly the edge the user asked
  // for. A flat 1px rule cannot read as a shape either.
  //
  // So the boundary is DRAWN instead of implied: a squircle stroke around the
  // whole page viewport, on all four sides, continuously, in the site's own
  // primary color.
  //
  // It is a border, and a border is allowed to sit on top of the page's
  // outermost pixels — that is what a border IS. The TINT is not allowed to
  // (see the one-tint-layer invariant in AGENTS.md). The two jobs stay
  // separate: the tint lives on chrome surfaces, the outline lives on the
  // page's edge, and neither may be used to do the other's job.
  const OUTLINE_ELEMENT_ID = 'zpt-page-outline';
  // The corner radius of the drawn boundary is a CSS knob
  // (--zpt-page-outline-radius), not a pref: nothing in JS needs it, because
  // the shape is CSS's job (corner-shape: squircle).

  let outlineElement = null;
  // Bumped on every color request; a resolve that comes back stale (the user
  // switched tabs meanwhile) must not paint the previous site's color.
  let outlineColorToken = 0;

  function applyOutlineState() {
    // The outline's on/off state also decides the page's own corner shape, so
    // it needs an attribute and not just a variable. It follows the same
    // outlineOn() answer as the width, which is what makes the toggle put the
    // page's own corners back for free: no outline attribute, no forced radius
    // 0 in style.css.
    if (outlineOn()) root.setAttribute('zen-page-tint-outline', 'on');
    else root.removeAttribute('zen-page-tint-outline');
  }

  // The outline is a plain element in the chrome document that we position
  // over the page viewport. It lives in the document body (NOT inside the
  // browser's container) so nothing clips it to the page's own rounded shape,
  // and it is position:fixed with viewport coordinates, which is exactly what
  // getBoundingClientRect() reports.
  function ensureOutlineElement() {
    if (outlineElement?.isConnected) return outlineElement;
    const host = document.body || document.documentElement;
    if (!host) return null;
    const el = document.createElement('div');
    el.id = OUTLINE_ELEMENT_ID;
    el.setAttribute('aria-hidden', 'true');
    // left/top are set explicitly (rather than left to the static position)
    // so the first measurement can tell where the containing block starts.
    el.style.left = '0px';
    el.style.top = '0px';
    host.appendChild(el);
    outlineElement = el;
    return el;
  }

  // The origin of the outline's containing block, in viewport coordinates. For
  // a fixed-position element that is the viewport itself — unless an ancestor
  // has a transform or a filter, which would make THAT ancestor the containing
  // block. It is measured rather than assumed: the element's own rect says
  // where it actually landed, so the difference is a constant offset to
  // subtract. The measurement reuses the layout flush the browser's rect read
  // already did, so it costs no extra reflow.
  let outlineOrigin = { x: 0, y: 0 };

  // Move the outline onto the browser's rect. The stroke is centered on the
  // box edge, so the box is inset by half of it: the whole line lands on the
  // page's own pixels instead of half of it hanging over the chrome.
  function updateOutlineGeometry(browser) {
    const el = ensureOutlineElement();
    if (!el || !browser) return;
    let rect;
    try { rect = browser.getBoundingClientRect(); } catch { return; }
    if (!rect || rect.width < 16 || rect.height < 16) return;

    // Where did the element actually land? The layout is clean here (the read
    // above flushed it), so this costs no extra reflow. A hidden element
    // reports a zero rect, which would be a lie — keep the last known origin.
    const cur = el.getBoundingClientRect();
    if (cur.width > 0 || cur.height > 0) {
      outlineOrigin.x = cur.left - (parseFloat(el.style.left) || 0);
      outlineOrigin.y = cur.top - (parseFloat(el.style.top) || 0);
    }

    const inset = OUTLINE_WIDTH / 2;
    el.style.left = `${rect.left + inset - outlineOrigin.x}px`;
    el.style.top = `${rect.top + inset - outlineOrigin.y}px`;
    el.style.width = `${Math.max(0, rect.width - OUTLINE_WIDTH)}px`;
    el.style.height = `${Math.max(0, rect.height - OUTLINE_WIDTH)}px`;
  }

  // ---- The site's primary color, from its favicon — the outline's FALLBACK ----
  //
  // The outline's first choice is a color found in the page's own pixels (frame.js
  // samples it; see updateOutlineColor). The favicon answers the different
  // question "what is this site's brand?", and it is the fallback for pages that
  // have no usable color of their own (a monochrome page, a page that is all
  // background). It is a good second choice for the reasons it always was: a
  // page's <meta name="theme-color"> is usually its background (GitHub's is
  // rgb(30,35,39)), scanning CSS custom properties means guessing at property
  // names across every framework, and the favicon is per-SITE — cached once per
  // host and reused by every tab on it — and needs no content process at all:
  // the chrome already has the tab, its icon and the host.
  //
  // The algorithm is borrowed from zen-tab-groups (MIT, (c) 2026 oom333), which
  // colors its section headers from the site icon — see LICENSE.
  const ICON_COLORS_PREF = 'zen.page-tint.icon-colors';
  const ICON_COLORS_MAX = 500;
  const ICON_LOAD_TIMEOUT_MS = 5000;
  // A site whose icon yields no color is retried after this long: the icon may
  // simply not have arrived yet (the browser shows a grey placeholder until it
  // does).
  const ICON_MISS_RETRY_MS = 30 * 60 * 1000;

  // host -> "#rrggbb", or "" for a sure answer of "this icon has no usable
  // color" (a monochrome logo). Both are cached, so the icon is fetched once
  // per site and not on every navigation.
  const iconColors = loadIconColors();
  // "We have no idea yet" — kept in memory only, so a restart is a good moment
  // to try again, and so a site without a color is not re-fetched on every
  // navigation.
  const iconColorMisses = new Map();
  // In-flight lookups, so two tabs on the same host don't fetch the icon twice.
  const iconColorJobs = new Map();

  function loadIconColors() {
    const map = new Map();
    const raw = prefStr(ICON_COLORS_PREF, '');
    if (!raw) return map;
    try {
      const obj = JSON.parse(raw);
      for (const [host, value] of Object.entries(obj)) {
        if (typeof value !== 'string') continue;
        if (/^#[0-9a-f]{6}$/i.test(value)) map.set(host, value.toLowerCase());
        else if (value === '') map.set(host, '');
      }
    } catch (e) { log('icon color cache parse failed', e); }
    return map;
  }

  function saveIconColors() {
    try {
      // Keep the pref bounded: it is a single JSON blob and a long-lived
      // session can visit hundreds of hosts.
      while (iconColors.size > ICON_COLORS_MAX) {
        iconColors.delete(iconColors.keys().next().value);
      }
      Services.prefs.setStringPref(ICON_COLORS_PREF, JSON.stringify(Object.fromEntries(iconColors)));
    } catch (e) { log('icon color cache save failed', e); }
  }

  // The cache key is the site, not the page: a color belongs to the brand, and
  // every tab on the same host should get the same outline.
  function siteKey(host) {
    return host.replace(/^www\./, '');
  }

  // The tab's own icon is the real favicon of THIS page, so it is the best
  // candidate — but on navigation it still holds the PREVIOUS page's icon
  // until the new favicon loads, which would cache one site's brand color
  // under another site's host. So it is only trusted when its URL points at
  // the same site.
  function tabIconFor(browser, site) {
    try {
      const tab = gBrowser.getTabForBrowser(browser);
      const src = tab?.getAttribute('image');
      if (!src) return null;
      if (src.startsWith('data:')) return null;   // no host to check against
      const host = new URL(src).hostname.toLowerCase();
      if (!host) return null;
      if (host !== site && !host.endsWith(`.${site}`)) return null;
      return src;
    } catch { return null; }
  }

  // Icon candidates for a site, most specific first:
  //   1. the open tab's own icon — the real favicon of THIS page
  //   2. page-icon: for the www host and for the bare host (the favicon
  //      service is keyed by URL, so one of the two usually has it)
  //   3. the site's own /favicon.ico
  function iconCandidates(browser, site) {
    const list = [];
    const tabIcon = tabIconFor(browser, site);
    if (tabIcon) list.push(tabIcon);
    list.push(`page-icon:https://www.${site}/`, `page-icon:https://${site}/`, `https://${site}/favicon.ico`);
    return list;
  }

  // The site's primary color, from its icon. Adapted from zen-tab-groups
  // (MIT, (c) 2026 oom333).
  //   - white, grey and near-black pixels never count, so a half white, half
  //     green logo is green
  //   - a mostly dark logo, or one with almost no color, gets no color at all
  //   - the most common exact shade wins when it clearly leads (a logo is
  //     usually flat color); otherwise the biggest hue family is averaged, so
  //     a gradient that crosses a family border isn't split in two
  function dominantColor(img) {
    const size = 32;
    const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    // No smoothing: blending pixels while scaling invents in-between shades.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, size, size);
    let data;
    try {
      data = ctx.getImageData(0, 0, size, size).data;
    } catch (e) {
      // A cross-origin icon taints the canvas and the read throws. The
      // page-icon: protocol is privileged and does not taint; a plain
      // https:// favicon usually does.
      return null;
    }

    // Count every exact colorful shade (logos use flat colors; gradients
    // spread over many slightly different ones), and its hue family
    // (12 families of 30°, shifted so pure red sits in the middle of one).
    const shades = new Map();
    const families = Array.from({ length: 12 }, () => ({ n: 0, r: 0, g: 0, b: 0 }));
    const add = (into, r, g, b) => { into.n++; into.r += r; into.g += g; into.b += b; };
    let opaque = 0;
    let dark = 0;
    let colorful = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      opaque++;
      const hsl = rgbToHsl(r, g, b);
      if (hsl.l < 0.2) { dark++; continue; }
      if (hsl.l > 0.85 || hsl.s < 0.25) continue;   // white / grey
      colorful++;
      const key = (r << 16) | (g << 8) | b;
      if (!shades.has(key)) shades.set(key, { n: 0, r: 0, g: 0, b: 0 });
      add(shades.get(key), r, g, b);
      add(families[Math.floor(((hsl.h * 360 + 15) % 360) / 30)], r, g, b);
    }
    if (!opaque || dark / opaque >= 0.75 || colorful / opaque < 0.08) return null;

    const sorted = [...shades.values()].sort((a, b) => b.n - a.n);
    const top = sorted[0];
    const second = sorted[1];
    let pick = top;
    if (second && top.n < second.n * 1.5 && top.n < colorful * 0.25) {
      const score = (i) => families[i].n + 0.5 * (families[(i + 11) % 12].n + families[(i + 1) % 12].n);
      let best = 0;
      for (let i = 1; i < 12; i++) if (score(i) > score(best)) best = i;
      pick = families[best];
    }
    const hsl = rgbToHsl(pick.r / pick.n, pick.g / pick.n, pick.b / pick.n);
    // Clamp for visibility: a brand color that is nearly black or nearly white
    // disappears against the page.
    const l = Math.min(Math.max(hsl.l, 0.45), 0.72);
    const s = Math.max(hsl.s, 0.45);
    const rgb = hslToRgb(hsl.h, s, l);
    return `#${[rgb.r, rgb.g, rgb.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }

  function loadIconImage(src) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (img) => { if (done) return; done = true; resolve(img); };
      const timer = setTimeout(() => finish(null), ICON_LOAD_TIMEOUT_MS);
      let img;
      try { img = new window.Image(); } catch { clearTimeout(timer); finish(null); return; }
      img.onload = () => { clearTimeout(timer); finish(img.naturalWidth ? img : null); };
      img.onerror = () => { clearTimeout(timer); finish(null); };
      try { img.src = src; } catch { clearTimeout(timer); finish(null); }
    });
  }

  async function resolveSiteColor(browser, site) {
    const cached = iconColors.get(site);
    if (cached !== undefined) return cached || null;
    const miss = iconColorMisses.get(site);
    if (miss !== undefined && Date.now() - miss < ICON_MISS_RETRY_MS) return null;
    if (iconColorJobs.has(site)) return iconColorJobs.get(site);
    const job = (async () => {
      let color = null;
      let sure = false;   // only a real icon's answer is worth caching
      for (const src of iconCandidates(browser, site)) {
        const img = await loadIconImage(src);
        if (!img) continue;
        try { color = dominantColor(img); } catch (e) { color = null; }
        // A page-icon: with no color may just be the browser's grey placeholder
        // (a site this profile has not visited yet), so try the next candidate.
        if (color || !src.startsWith('page-icon:')) { sure = true; break; }
      }
      iconColorJobs.delete(site);
      if (sure) {
        iconColors.set(site, color || '');
        saveIconColors();
      } else {
        iconColorMisses.set(site, Date.now());
      }
      log('site color', site, '->', color || '(none)');
      return color;
    })();
    iconColorJobs.set(site, job);
    return job;
  }

  // Ask for the site's color and paint it when it arrives. Used as the FALLBACK
  // when the page itself yielded no chromatic color (see updateOutlineColor).
  // The color is written as a variable and CSS picks the fallback chain:
  //   page color (from the frame) / site color (favicon) -> the tint's own
  //   foreground (the old hairline) -> nothing.
  let lastSiteColor = null;
  function setSiteColor(color) {
    // Deduped: the same site comes back on every tab switch, and rewriting an
    // unchanged custom property still invalidates style for every var()
    // consumer in the chrome.
    if (color === lastSiteColor) return;
    lastSiteColor = color || null;
    if (color) root.style.setProperty('--zpt-page-site-color', color);
    else root.style.removeProperty('--zpt-page-site-color');
  }

  // Drop the site's color and discard any lookup still in flight for the page
  // we just left — it would paint the previous site's color over the new one.
  function clearOutlineColor() {
    outlineColorToken++;
    setSiteColor(null);
  }

  function requestOutlineColor(browser) {
    const url = browser?.currentURI?.spec || '';
    let host = null;
    try { host = new URL(url).hostname.toLowerCase(); } catch {}
    if (!host || isInternalUrl(url)) {
      clearOutlineColor();
      return;
    }
    const token = ++outlineColorToken;
    resolveSiteColor(browser, siteKey(host)).then((color) => {
      if (token !== outlineColorToken) return;   // a newer tab took over
      setSiteColor(color);
    }).catch(() => {});
  }

  // The page's own color wins outright when the frame supplied one: it is drawn
  // on the page by definition, needs no per-site cache, and skips the favicon
  // round trip (and its "the outline color arrives a beat after the tint"
  // caveat). Bumping the token invalidates any favicon lookup still in flight
  // from the previous page — it would otherwise overwrite this answer when it
  // lands. No page color (a monochrome page, or drawWindow unavailable) means
  // the site's brand color is the fallback, exactly as before.
  function updateOutlineColor(browser, pageColor) {
    if (pageColor) {
      outlineColorToken++;
      setSiteColor(pageColor);
      return;
    }
    requestOutlineColor(browser);
  }

  // Keep the outline on the browser's rect as the layout moves (sidebar
  // expand/collapse, window resize, Zen's compact mode). The observer fires on
  // the browser element's SIZE change, which covers every one of those; the
  // window resize listener is the belt-and-suspenders for the cases where the
  // element is re-laid-out without a size change.
  let observedBrowser = null;
  const outlineResizeObserver = new ResizeObserver(() => {
    const browser = gBrowser.selectedBrowser;
    if (browser) updateOutlineGeometry(browser);
  });
  function observeOutlineBrowser(browser) {
    if (observedBrowser === browser) return;
    try { if (observedBrowser) outlineResizeObserver.unobserve(observedBrowser); } catch {}
    observedBrowser = browser;
    if (browser) { try { outlineResizeObserver.observe(browser); } catch {} }
  }

  // The outline follows the TINTED page: it is part of the same behaviour, so
  // an untinted page (about:, a disabled host, a page with no declared
  // background) gets no outline either. The attribute gate is in CSS; this
  // only moves and colors it.
  //
  // `pageColor` is the color the frame script found in the page's own pixels.
  // It is the preferred answer (the line is drawn ON the page, so a color the
  // page contains belongs to it); the favicon is only the fallback when the page
  // yielded no usable color.
  function updateOutlineFor(browser, pageColor) {
    // Switched off (or width 0): there is nothing to move, color or observe,
    // and rebuilding the element on every tab switch would quietly undo the
    // toggle. Tear down anything left over and stop here — this is the guard
    // that makes "off" mean off for the whole per-switch path.
    if (!outlineOn()) {
      if (outlineElement || observedBrowser) removeOutlineElement();
      return;
    }
    if (!browser) return;
    showOutline(true);
    updateOutlineGeometry(browser);
    observeOutlineBrowser(browser);
    updateOutlineColor(browser, pageColor);
  }

  // The Glance overlay dims the parent page and covers the content area, so
  // the parent's outline would be drawn over the dim. Hide it until the Glance
  // is expanded into a normal tab.
  function showOutline(visible) {
    if (!outlineElement) return;
    outlineElement.style.display = visible ? '' : 'none';
  }

  function removeOutlineElement() {
    // Invalidate any icon lookup still in flight: it must not resurrect
    // --zpt-page-site-color after the element (and the feature) is gone.
    outlineColorToken++;
    try { outlineResizeObserver.disconnect(); } catch {}
    try { if (observedBrowser) outlineResizeObserver.unobserve(observedBrowser); } catch {}
    observedBrowser = null;
    try { outlineElement?.remove(); } catch {}
    outlineElement = null;
    lastSiteColor = null;
    root.style.removeProperty('--zpt-page-site-color');
  }

  // Write the tint variables for a raw sampled color (null, or strength 0, clears
  // the tint so Zen renders natively). Saturation / lightness adjustments are
  // applied here; the overlay OPACITY is handled in CSS by --zpt-strength; and the
  // readable foreground is picked against the ADJUSTED color so contrast stays
  // correct.
  const EDGE_VARS = { l: '--zpt-edge-l', r: '--zpt-edge-r', t: '--zpt-edge-t', b: '--zpt-edge-b' };

  function clearEdgeVars() {
    for (const name of Object.values(EDGE_VARS)) root.style.removeProperty(name);
    root.removeAttribute('zen-page-tint-ambient');
  }

  function renderTint(rawBg, rawEdges) {
    if (rawBg && MIX_AMOUNT > 0) {
      const tint = transformColor(rawBg);
      const fg = readableFg(tint) || 'inherit';
      root.style.setProperty('--zen-tab-header-background', tint);
      root.style.setProperty('--zen-tab-header-foreground', fg);
      root.setAttribute('zen-page-tint', 'on');

      // Directional gradient. Edge colors go through the SAME transform as the
      // base so a saturation or brightness change moves all of them together —
      // otherwise the gradient would drift out of family with the surface it sits
      // on. The attribute gates the CSS: without it there is no gradient rule at
      // all, so spread 0 costs nothing rather than painting a transparent one.
      if (AMBIENT_SPREAD > 0 && rawEdges) {
        let ok = true;
        const stops = {};
        for (const key of Object.keys(EDGE_VARS)) {
          const stop = rawEdges[key] ? edgeStop(transformColor(rawEdges[key])) : null;
          if (!stop) { ok = false; break; }
          stops[key] = stop;
        }
        if (ok) {
          for (const [key, name] of Object.entries(EDGE_VARS)) root.style.setProperty(name, stops[key]);
          root.setAttribute('zen-page-tint-ambient', 'on');
        } else {
          clearEdgeVars();
        }
      } else {
        clearEdgeVars();
      }
    } else {
      root.style.removeProperty('--zen-tab-header-background');
      root.style.removeProperty('--zen-tab-header-foreground');
      root.removeAttribute('zen-page-tint');
      clearEdgeVars();
    }
  }

  // Track the last applied (raw) theme so switching between same-colored tabs (the
  // common case — most pages are white or one of a few grays) doesn't rewrite the
  // CSS variables and trigger a full restyle of every var() consumer (including the
  // per-tab rules × thousands of tabs) plus a re-armed 1s fade. Compared by
  // signature rather than identity because the theme is now an object rebuilt on
  // every message, so `===` would never match and the dedupe would be dead.
  let lastAppliedTheme = null;
  let lastAppliedSig = undefined;
  function themeSig(theme) {
    if (!theme || !theme.bg) return null;
    const e = theme.edges;
    return e ? `${theme.bg}|${e.l}|${e.r}|${e.t}|${e.b}` : theme.bg;
  }
  function applyTheme(theme) {
    const next = (theme && theme.bg) ? theme : null;
    const sig = themeSig(next);
    if (sig === lastAppliedSig) return;
    lastAppliedSig = sig;
    lastAppliedTheme = next;
    renderTint(next && next.bg, next && next.edges);
  }

  // Re-render from the last raw theme without the same-color dedupe. Used when an
  // appearance pref (strength / saturation / brightness / contrast / lightness /
  // spread) changes live: the raw page color is unchanged but its rendered result
  // isn't.
  function reapplyTint() {
    renderTint(lastAppliedTheme && lastAppliedTheme.bg, lastAppliedTheme && lastAppliedTheme.edges);
  }

  function cacheKey(uri) {
    try { const u = new URL(uri); return u.origin + u.pathname; }
    catch { return uri || ''; }
  }

  function cacheGet(key) {
    const value = themeCache.get(key);
    if (value !== undefined) { themeCache.delete(key); themeCache.set(key, value); }
    return value;
  }

  function cacheSet(key, value) {
    if (themeCache.has(key)) themeCache.delete(key);
    else if (themeCache.size >= CACHE_MAX) themeCache.delete(themeCache.keys().next().value);
    themeCache.set(key, value);
  }

  // Per-browser record: { mm, listener, loaded }. Keyed by browser element (weak),
  // but we track the messageManager identity too: a discarded/restored tab,
  // remoteness change, or tab tear-off recreates the mm, and the listener must be
  // re-attached to the live one (the old "have we attached?" boolean guard left
  // restored tabs with no listener at all).
  const browserState = new WeakMap();

  // A transient Zen Glance is selected like a normal browser, but Zen still shows
  // its parent page behind the overlay. Keep the shared chrome on the parent's
  // tint until the child is expanded into a normal tab, at which point Zen removes
  // this attribute and the observer below samples the child normally.
  function isTransientGlance(browser) {
    try { return gBrowser.getTabForBrowser(browser)?.hasAttribute(GLANCE_TAB_ATTRIBUTE) === true; }
    catch { return false; }
  }

  function makeListener(browser) {
    return (msg) => {
      const theme = msg.data || {};
      const current = browser.currentURI?.spec || '';
      // Key by the URL the sample was actually taken from (sent as href), not the
      // browser's current URI — an in-flight sample from the previous document can
      // arrive after navigation, and must not be cached/applied under the new URL.
      const sampled = theme.href || current;
      if (isInternalUrl(sampled) || hostMatches(sampled, DISABLE_HOSTS)) return;
      const key = cacheKey(sampled);
      const isCurrent = cacheKey(current) === key;
      const canApply = isCurrent && gBrowser.selectedBrowser === browser && !isTransientGlance(browser);
      log('message received', { source: theme.source, bg: theme.bg, outlineColor: theme.outlineColor, url: sampled });

      if (theme.bg) {
        // Cache the whole sampled theme (color + directional edges + the outline's
        // page color), not just the color: a cache hit has to be able to restore
        // all of it, or revisiting a tab would silently drop to a flat tint and
        // the favicon fallback.
        const entry = {
          bg: theme.bg,
          edges: theme.edges || null,
          outlineColor: theme.outlineColor || null,
        };
        cacheSet(key, entry);
        if (canApply) {
          applyTheme(entry);
          // The outline is updated OUTSIDE applyTheme: applyTheme dedupes
          // same-colored pages (most pages are white or one of a few greys),
          // but the outline's color comes from the page's own pixels, and two
          // white pages can hold different colors. It falls back to the site's
          // favicon when the page yielded none.
          updateOutlineFor(browser, entry.outlineColor);
          log('applied', { bg: theme.bg, edges: !!theme.edges });
        }
      } else if (canApply) {
        // Genuine "no color found" on the page currently shown — drop the stale
        // cache entry and clear the tint (otherwise the previous page's tint
        // lingers on a colorless / transparent page). Gated on selected+current so
        // a background duplicate-URL tab's transient pre-paint null can't evict the
        // entry a foreground tab on the same URL is relying on.
        themeCache.delete(key);
        applyTheme(null);
        updateOutlineFor(browser);
      }
    };
  }

  // Drop both message listeners recorded for a browser. Shared so the two removal
  // sites (stale-mm re-attach, and detach on TabClose / cleanup) can't drift apart
  // and leak one listener — which is what a hand-rolled second copy invites.
  function removeListeners(rec) {
    if (!rec || !rec.mm) return;
    if (rec.listener) { try { rec.mm.removeMessageListener(MESSAGE_NAME, rec.listener); } catch {} }
    if (rec.readyListener) { try { rec.mm.removeMessageListener(READY_MESSAGE_NAME, rec.readyListener); } catch {} }
  }

  // Attach (or re-attach) the chrome-side message listener for a browser. Returns
  // the record, or null if no message manager is available.
  function ensureAttached(browser) {
    if (!browser) return null;
    const mm = browser.messageManager;
    if (!mm?.addMessageListener) return null;
    let rec = browserState.get(browser);
    if (rec && rec.mm === mm) return rec;
    // New browser, or the mm was recreated under us — drop any stale listener and
    // attach to the live mm.
    removeListeners(rec);
    const listener = makeListener(browser);
    const readyListener = () => { log('frame script ready; pushing config'); sendConfig(browser); };
    try {
      mm.addMessageListener(MESSAGE_NAME, listener);
      mm.addMessageListener(READY_MESSAGE_NAME, readyListener);
    }
    catch (e) {
      // Drop any stale record so the next attempt retries cleanly, rather than
      // leaving a record with loaded:true that makes the cache-hit path skip the
      // frame-script reload for this (still-unlistened) browser.
      log('listener attach failed', e);
      browserState.delete(browser);
      return null;
    }
    rec = { mm, listener, readyListener, loaded: false };
    browserState.set(browser, rec);
    log('listener attached');
    return rec;
  }

  // Config is sent unconditionally — the live-mode master switch is expressed as
  // liveRateMs: 0 (which the frame script already treats as "never poll") rather
  // than by skipping the message. Bailing early here would also starve the
  // non-live settings below it, silently pinning them to the frame script's
  // built-in defaults for anyone running with live mode off.
  function sendConfig(browser) {
    const mm = browser.messageManager;
    if (!mm?.sendAsyncMessage) return;
    try {
      const url = browser.currentURI?.spec || '';
      mm.sendAsyncMessage(CONFIG_MESSAGE_NAME, {
        liveRateMs: LIVE_MODE ? LIVE_RATE_MS : 0,
        alwaysOn: LIVE_ALWAYS_ON || hostMatches(url, LIVE_HOSTS),
        threshold: LIVE_THRESHOLD,
        debug: DEBUG,
        ytAmbient: YT_AMBIENT,
        lightAverage: LIGHT_AVERAGE,
        // Which color to sample. Decided here, executed in the content process —
        // the frame script owns the page, so it has to be told.
        colorSource: COLOR_SOURCE,
        // Only ask for per-edge colors when something will actually render them.
        // Under the page-background source there is no grid sample at all, so the
        // edge colors could never be computed — asking for them would be a lie.
        edges: AMBIENT_SPREAD > 0 && COLOR_SOURCE !== PAGE_BACKGROUND,
        // Ask the frame to sample the outline's color from the page's own pixels.
        // Independent of the tint source, and off when the outline is off — that
        // is what keeps the declared path free of compositor reads when nothing
        // will draw the line.
        outline: outlineOn(),
      });
    } catch (e) { log('config message send failed', e); }
  }

  // Load the frame script into the browser's content process and push config.
  // frame.js's globalThis guard makes a repeat load cheap (it just re-samples the
  // current document). Marks the record loaded so cache hits can skip re-loading.
  function loadFrameScript(browser) {
    const mm = browser.messageManager;
    if (!mm?.loadFrameScript) return;
    try {
      mm.loadFrameScript(FRAME_SCRIPT_URL, false);
      sendConfig(browser);
      const rec = browserState.get(browser);
      if (rec) rec.loaded = true;
      log('frame script load requested');
    } catch (e) { log('frame script load failed', e); }
  }

  function detachBrowser(browser) {
    if (!browser) return;
    removeListeners(browserState.get(browser));
    browserState.delete(browser);
    log('detached');
  }

  function sendTeardown(browser) {
    const mm = browser.messageManager;
    if (!mm?.sendAsyncMessage) return;
    try { mm.sendAsyncMessage(TEARDOWN_MESSAGE_NAME, {}); } catch {}
  }

  function sampleAndApply(browser, forceFresh = false) {
    if (!browser) return;
    if (isTransientGlance(browser)) {
      log('transient Glance selected; preserving parent tint');
      showOutline(false);
      return;
    }
    const url = browser.currentURI?.spec || '';

    // Internal pages and per-site-disabled hosts keep Zen's own chrome (no tint).
    if (isInternalUrl(url) || hostMatches(url, DISABLE_HOSTS)) {
      applyTheme(null);
      // No outline either: the boundary belongs to the same behaviour as the
      // tint it belongs to.
      clearOutlineColor();
      return;
    }

    const key = cacheKey(url);

    if (forceFresh) {
      // Pre-delete so a fast subsequent TabSelect doesn't read the stale value.
      themeCache.delete(key);
      ensureAttached(browser);
      loadFrameScript(browser);
      return;
    }

    const hit = cacheGet(key);
    if (hit !== undefined) {
      applyTheme(hit);
      updateOutlineFor(browser, hit.outlineColor);
      // The cache is keyed by URL, not browser, so a hit can land on a tab whose
      // content process never loaded frame.js (a duplicate-URL tab, or one whose
      // mm was recreated). Ensure the listener is live, and load the frame script
      // once if it isn't already running — otherwise that tab gets the static tint
      // but no mutation/live-mode updates. Repeat visits keep the fast path.
      const rec = ensureAttached(browser);
      if (rec && !rec.loaded) loadFrameScript(browser);
      return;
    }

    // Cache miss: need a sample.
    ensureAttached(browser);
    loadFrameScript(browser);
  }

  // Coalesce rapid back-to-back schedule calls into a single run. We race
  // requestAnimationFrame (yields to next paint) against a setTimeout safety net
  // (rAF can be throttled when the window is occluded); whichever fires first
  // wins and cancels the other.
  const SCHEDULE_SAFETY_MS = 100;
  let scheduled = false;
  let scheduledForce = false;
  let scheduleRafId = 0;
  let scheduleTimerId = 0;
  function runScheduled() {
    if (!scheduled) return; // already ran via the other path
    scheduled = false;
    try { if (scheduleRafId) cancelAnimationFrame(scheduleRafId); } catch {}
    try { if (scheduleTimerId) clearTimeout(scheduleTimerId); } catch {}
    scheduleRafId = 0;
    scheduleTimerId = 0;
    const force = scheduledForce;
    scheduledForce = false;
    sampleAndApply(gBrowser.selectedBrowser, force);
  }
  function scheduleSample(forceFresh = false) {
    if (forceFresh) scheduledForce = true;
    if (scheduled) return;
    scheduled = true;
    scheduleRafId = requestAnimationFrame(runScheduled);
    scheduleTimerId = setTimeout(runScheduled, SCHEDULE_SAFETY_MS);
  }

  // Named handlers so cleanup() can remove them.
  const onTabSelect = () => scheduleSample(false);
  const onTabClose = (evt) => { const browser = evt.target?.linkedBrowser; if (browser) detachBrowser(browser); };
  gBrowser.tabContainer.addEventListener('TabSelect', onTabSelect);
  gBrowser.tabContainer.addEventListener('TabClose', onTabClose);

  // Expanding a Glance removes zen-glance-tab without necessarily selecting a
  // different tab, so TabSelect alone cannot hand tint ownership to the child.
  // Observe only that one attribute and sample once it disappears from the
  // currently selected tab. Opening/closing Glance still uses the normal guards
  // and TabSelect path.
  const glanceObserver = new MutationObserver((records) => {
    const selectedTab = gBrowser.selectedTab;
    if (!selectedTab || selectedTab.hasAttribute(GLANCE_TAB_ATTRIBUTE)) return;
    if (records.some((record) => record.target === selectedTab)) scheduleSample(false);
  });
  glanceObserver.observe(gBrowser.tabContainer, {
    attributes: true,
    attributeFilter: [GLANCE_TAB_ATTRIBUTE],
    subtree: true,
  });

  // onLocationChange: top-level navigation/reload in active tab — bypass cache.
  const progressListener = {
    QueryInterface: ChromeUtils.generateQI(['nsIWebProgressListener', 'nsISupportsWeakReference']),
    onLocationChange(progress, request, location, flags) {
      if (!progress?.isTopLevel) return;
      if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) return;
      scheduleSample(true);
    },
    onStateChange() {}, onProgressChange() {}, onStatusChange() {},
    onSecurityChange() {}, onContentBlockingEvent() {},
  };
  gBrowser.addProgressListener(progressListener);

  // Initial run after the window finishes loading.
  if (document.readyState === 'complete') scheduleSample(false);
  else window.addEventListener('load', () => scheduleSample(false), { once: true });

  // OS color scheme change: every cached entry is now stale. Clear and re-sample.
  let colorSchemeQuery = null;
  let onColorSchemeChange = null;
  try {
    colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    onColorSchemeChange = () => { themeCache.clear(); log('color-scheme changed, cache cleared'); scheduleSample(true); };
    colorSchemeQuery.addEventListener('change', onColorSchemeChange);
  } catch {}

  // The outline is positioned over the page viewport, so it has to follow the
  // layout: a window resize moves the browser's rect. (The ResizeObserver on
  // the browser element covers the rest — sidebar expand/collapse, Zen's
  // compact mode, the toolbar collapsing.)
  const onWindowResize = () => {
    const browser = gBrowser.selectedBrowser;
    if (browser) updateOutlineGeometry(browser);
  };
  window.addEventListener('resize', onWindowResize);

  // Live-apply the appearance prefs (mix / saturation / lightness / gap / radius /
  // outline / disable-hosts) when they're changed from the Sine settings panel, so the
  // effect is visible without a restart. (The live-mode prefs are read once at
  // frame-script load and still need a restart — Sine shows a restart toast for
  // those.) A branch observer catches every zen.page-tint.* change; we act only on
  // the live-applicable ones.
  const prefObserver = {
    observe(_subject, topic, data) {
      if (topic !== 'nsPref:changed') return;
      switch (data) {
        case 'zen.page-tint.mix-amount':
          MIX_AMOUNT = clampInt(prefInt('zen.page-tint.mix-amount', 100), 0, 100);
          applyCssVarPrefs();   // push the new --zpt-strength
          reapplyTint();        // re-evaluate the tint (strength may have crossed 0)
          break;
        case 'zen.page-tint.saturation':
          SATURATION = clampInt(prefInt('zen.page-tint.saturation', 100), 0, 200);
          reapplyTint();
          break;
        case 'zen.page-tint.min-lightness':
        case 'zen.page-tint.max-lightness':
          MIN_LIGHT = clampInt(prefInt('zen.page-tint.min-lightness', 0), 0, 100);
          MAX_LIGHT = clampInt(prefInt('zen.page-tint.max-lightness', 100), 0, 100);
          reapplyTint();
          break;
        case 'zen.page-tint.brightness':
          BRIGHTNESS = clampInt(prefInt('zen.page-tint.brightness', 100), 0, 300);
          reapplyTint();
          break;
        case 'zen.page-tint.contrast':
          CONTRAST = clampInt(prefInt('zen.page-tint.contrast', 100), 0, 300);
          reapplyTint();
          break;
        case 'zen.page-tint.ambient-spread': {
          const wasOn = AMBIENT_SPREAD > 0;
          AMBIENT_SPREAD = clampInt(prefInt('zen.page-tint.ambient-spread', 0), 0, 100);
          // Crossing the 0 boundary flips whether the frame script computes edges at
          // all, so cached entries are now the wrong shape. Within a non-zero range
          // only the overlay alpha changes, which is a pure re-render.
          //
          // Clearing the cache is the ONLY propagation needed: every tab becomes a
          // miss, and the miss path already calls loadFrameScript() → sendConfig().
          // Do NOT iterate gBrowser.browsers to push config eagerly — that touches
          // .messageManager on every tab, which instantiates lazy session-restore
          // browsers and floods IPC. At this project's target tab counts it hangs the
          // window outright (observed at ~1660 tabs). scheduleSample handles the tab
          // the user is actually looking at; the rest fix themselves on select.
          if (wasOn !== (AMBIENT_SPREAD > 0)) {
            themeCache.clear();
            scheduleSample(true);
          } else {
            reapplyTint();
          }
          break;
        }
        case 'zen.page-tint.disable-hosts':
          DISABLE_HOSTS = parseHostList(prefStr('zen.page-tint.disable-hosts', ''));
          scheduleSample(false); // re-evaluate the active tab (clear or restore)
          break;
        case 'zen.page-tint.frame-gap':
        case 'zen.page-tint.frame-radius':
          applyCssVarPrefs();
          break;
        case 'zen.page-tint.page-outline': {
          const wasOn = outlineOn();
          OUTLINE_ENABLED = prefBool('zen.page-tint.page-outline', true);
          applyCssVarPrefs();
          applyOutlineState();
          // The frame samples the outline color only while something will draw
          // it (config.outline), so the switch changes WHAT a sample yields.
          // Same propagation as a source change: cached entries are now the wrong
          // shape, so clear and force one fresh sample — its miss path pushes the
          // new config. Do NOT push config by iterating tabs (see the
          // ambient-spread case for why).
          if (outlineOn() !== wasOn) {
            themeCache.clear();
            scheduleSample(true);
          }
          // The switch is expected to be instant, so the page on screen is
          // handled here rather than on the next tab switch. On: rebuild (or
          // re-measure) the element and its color. Off: tear the whole thing
          // down — element, ResizeObserver, site color, in-flight lookup.
          if (outlineOn()) updateOutlineFor(gBrowser.selectedBrowser);
          else removeOutlineElement();
          break;
        }
        case 'zen.page-tint.page-outline-width': {
          const wasOn = outlineOn();
          OUTLINE_WIDTH = clampInt(prefInt('zen.page-tint.page-outline-width', 2), 0, 8);
          applyCssVarPrefs();
          applyOutlineState();
          // A width change is normally a pure re-measure. Crossing 0 flips the
          // feature off/on, which changes the config the frame samples under.
          if (outlineOn() !== wasOn) {
            themeCache.clear();
            scheduleSample(true);
          }
          // The stroke width is half of the box inset, so the outline's box
          // has to be recomputed — and the page's own corner shape flips with
          // the attribute. Width 0 is "off" too, so it takes the same
          // teardown path as the switch instead of re-creating the element.
          if (outlineOn()) updateOutlineGeometry(gBrowser.selectedBrowser);
          else removeOutlineElement();
          break;
        }
        // Color-source changes invalidate every cached sample, since the cache
        // stores the resulting color rather than the pixels it came from. Clear
        // and force a fresh sample — same treatment as an OS color-scheme flip.
        // Other tabs re-sample on their next select, which is now a cache miss and
        // therefore reloads the frame script (re-pushing this config with it).
        case 'zen.page-tint.youtube-ambient':
        case 'zen.page-tint.light-average':
        case 'zen.page-tint.color-source':
          YT_AMBIENT = prefBool('zen.page-tint.youtube-ambient', true);
          LIGHT_AVERAGE = prefBool('zen.page-tint.light-average', false);
          COLOR_SOURCE = normalizeColorSource(prefStr('zen.page-tint.color-source', DEFAULT_COLOR_SOURCE));
          themeCache.clear();
          scheduleSample(true);
          break;
      }
    },
  };
  try { Services.prefs.addObserver('zen.page-tint.', prefObserver); }
  catch (e) { log('pref observer add failed', e); }

  // Cleanup on window unload / mod hot-reload. Sine's addUnloadListener is
  // preferred (it survives hot-reload); fall back to a one-shot 'unload'.
  const cleanup = () => {
    try { gBrowser.removeProgressListener(progressListener); } catch {}
    try { gBrowser.tabContainer.removeEventListener('TabSelect', onTabSelect); } catch {}
    try { gBrowser.tabContainer.removeEventListener('TabClose', onTabClose); } catch {}
    try { glanceObserver.disconnect(); } catch {}
    try {
      if (colorSchemeQuery && onColorSchemeChange) colorSchemeQuery.removeEventListener('change', onColorSchemeChange);
    } catch {}
    try { window.removeEventListener('resize', onWindowResize); } catch {}
    try { Services.prefs.removeObserver('zen.page-tint.', prefObserver); } catch {}
    try { if (scheduleRafId) cancelAnimationFrame(scheduleRafId); } catch {}
    try { if (scheduleTimerId) clearTimeout(scheduleTimerId); } catch {}
    scheduled = false;
    // Detach each browser's listener and tell its content process to tear down
    // (stop observers / polling). Iterates live browsers because the per-browser
    // WeakMap isn't enumerable; closed tabs already detached on TabClose.
    //
    // Skips lazy (unrestored) tabs via tab.linkedPanel, which is tabbrowser.js's own
    // "browser is inserted" idiom. Reading .messageManager on a lazy browser trips
    // the property trap that calls _insertBrowser() — messageManager is not on the
    // safe-while-lazy list — so an unguarded sweep instantiates every restored-
    // session tab just to tear it down. At 1600+ tabs that's a multi-second hang on
    // window close or mod hot-reload. A lazy tab never ran the frame script and never
    // had a listener attached, so there is nothing there to clean up anyway.
    try {
      for (const tab of gBrowser.tabs) {
        if (!tab.linkedPanel) continue;
        const browser = tab.linkedBrowser;
        if (!browser) continue;
        detachBrowser(browser);
        sendTeardown(browser);
      }
    } catch {}
    applyTheme(null);
    removeOutlineElement();
    root.removeAttribute('zen-page-tint-active');
    root.removeAttribute('zen-page-tint-live');
    root.removeAttribute('zen-page-tint-outline');
  };
  if (typeof addUnloadListener === 'function') addUnloadListener(cleanup);
  else window.addEventListener('unload', cleanup, { once: true });

  log('initialized');
})();
