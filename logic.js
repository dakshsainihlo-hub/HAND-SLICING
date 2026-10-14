// Pure logic with no DOM access, so it can be unit-tested in Node.
// Everything tunable lives in CONFIG / MODES, with the reasoning next to each value.

export const CONFIG = {
  gesture: {
    // Finger extension is measured as dist(tip, wrist) / dist(knuckle, wrist).
    // A straight finger puts the tip ~1.8-2.1x as far from the wrist as its knuckle;
    // a curled finger folds the tip back to ~0.7-1.3x. Using a ratio (not pixels)
    // makes it independent of hand size, camera distance and hand rotation.
    extendedRatio: 1.6,
    foldedRatio: 1.4,
    // Open palm also needs spread fingers: dist(indexTip, pinkyTip) / knuckle width.
    // Closed-together straight fingers measure ~1.0, an open hand ~1.5+.
    palmSpread: 1.15,
    // Consecutive frames a gesture must hold before it is "confirmed".
    // Fist/palm trigger actions, so they need more proof than pointing.
    stableFrames: { NO_HAND: 5, INDEX_POINTING: 2, OTHER_GESTURE: 3, FIST: 4, OPEN_PALM: 7 },
    // Raw pointing frames required before the blade becomes active (re-arming).
    armFrames: 3,
  },
  map: {
    mirror: true, // selfie view: moving your hand right moves the blade right
    margin: 0.1, // use the central 80% of the camera frame so screen edges are reachable
  },
  smoothing: {
    minAlpha: 0.35, // slow movement: heavy smoothing to hide landmark jitter
    maxAlpha: 0.95, // fast swipes: almost no smoothing so the blade never lags
    speedGain: 0.4, // alpha rises with speed (screen-diagonals per second)
    jumpLimit: 0.5, // a jump bigger than half the diagonal in one sample is a tracking glitch
  },
  score: {
    comboWindow: 1.0, // seconds between slices that keep a combo alive
    swipeBonus: 3, // per extra fruit once 3+ are cut in a single swipe
    bombPenalty: 15,
    bombClearPerFruit: 5,
    multiplierEvery: 5, // combo steps per multiplier level
    maxMultiplier: 4,
  },
  bombCooldown: 8, // seconds between bomb-clear charges
  inferFps: 30,
};

export const MODES = {
  time: {
    id: 'time', name: 'Time Attack', duration: 60, bombs: true, gravity: 1, interval: 1, lives: null,
    desc: '60 seconds. Waves speed up. Bombs cost points.',
  },
  zen: {
    id: 'zen', name: 'Zen', duration: 120, bombs: false, gravity: 0.75, interval: 1.35, lives: null,
    desc: 'Two relaxed minutes. Slower fruit, no bombs.',
  },
  endless: {
    id: 'endless', name: 'Endless', duration: null, bombs: true, gravity: 1, interval: 1, lives: 3,
    desc: 'No clock. Three bomb hits end the run.',
  },
};

export const FRUIT_TYPES = ['watermelon', 'orange', 'apple', 'strawberry', 'pineapple', 'lemon', 'peach', 'coconut'];
export const FRUIT_POINTS = {
  watermelon: 3, orange: 2, apple: 2, strawberry: 4, pineapple: 5, lemon: 3, peach: 3, coconut: 6,
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- gestures
const FINGERS = [[5, 8], [9, 12], [13, 16], [17, 20]]; // [knuckle, tip] for index, middle, ring, pinky

export function fingerRatio(lm, knuckle, tip) {
  return dist(lm[tip], lm[0]) / Math.max(1e-6, dist(lm[knuckle], lm[0]));
}

/** Classify 21 MediaPipe hand landmarks. Returns { gesture, ratios, indexExtended }. */
export function classifyHand(lm, cfg = CONFIG.gesture) {
  if (!lm || lm.length < 21) return { gesture: 'NO_HAND', ratios: [], indexExtended: false };
  const ratios = FINGERS.map(([k, t]) => fingerRatio(lm, k, t));
  const ext = ratios.map((r) => r >= cfg.extendedRatio);
  const fold = ratios.map((r) => r < cfg.foldedRatio);
  const knuckleWidth = Math.max(1e-6, dist(lm[5], lm[17]));
  const spread = dist(lm[8], lm[20]) / knuckleWidth;
  let gesture = 'OTHER_GESTURE';
  if (ext.every(Boolean)) {
    gesture = spread >= cfg.palmSpread ? 'OPEN_PALM' : 'OTHER_GESTURE';
  } else if (ext[0] && fold[1] && fold[2] && fold[3]) {
    gesture = 'INDEX_POINTING';
  } else if (fold.every(Boolean)) {
    gesture = 'FIST';
  }
  return { gesture, ratios, indexExtended: ext[0] };
}

/** Debounces raw per-frame gestures. `entered` is set only on the frame a new gesture is confirmed. */
export class GestureStabilizer {
  constructor(frames = CONFIG.gesture.stableFrames) {
    this.frames = frames;
    this.reset();
  }
  reset() {
    this.stable = 'NO_HAND';
    this.candidate = 'NO_HAND';
    this.count = 0;
  }
  update(raw) {
    if (raw === this.candidate) this.count++;
    else { this.candidate = raw; this.count = 1; }
    let entered = null;
    if (this.candidate !== this.stable && this.count >= (this.frames[this.candidate] ?? 3)) {
      this.stable = this.candidate;
      entered = this.candidate;
    }
    return { stable: this.stable, entered };
  }
}

// ---------------------------------------------------------------- coordinates
/** Normalised landmark (0-1, camera space) -> arena pixels, with mirroring and edge margin. */
export function mapToArena(p, w, h, cfg = CONFIG.map) {
  let x = cfg.mirror ? 1 - p.x : p.x;
  let y = p.y;
  const span = 1 - 2 * cfg.margin;
  x = clamp((x - cfg.margin) / span, 0, 1);
  y = clamp((y - cfg.margin) / span, 0, 1);
  return { x: x * w, y: y * h };
}

/** Speed-adaptive exponential smoothing with glitch rejection. */
export class PointSmoother {
  constructor(cfg = CONFIG.smoothing) { this.cfg = cfg; this.last = null; this.lastT = 0; }
  reset() { this.last = null; }
  update(p, tMs, w, h) {
    const diag = Math.hypot(w, h);
    if (!this.last) { this.last = { x: p.x, y: p.y }; this.lastT = tMs; return { x: p.x, y: p.y, jumped: true }; }
    const dt = Math.max(0.001, (tMs - this.lastT) / 1000);
    const d = Math.hypot(p.x - this.last.x, p.y - this.last.y);
    this.lastT = tMs;
    if (d / diag > this.cfg.jumpLimit) { // implausible jump: re-seed, caller must not draw/slice across it
      this.last = { x: p.x, y: p.y };
      return { x: p.x, y: p.y, jumped: true };
    }
    const speed = d / diag / dt;
    const a = clamp(this.cfg.minAlpha + speed * this.cfg.speedGain, this.cfg.minAlpha, this.cfg.maxAlpha);
    this.last = { x: this.last.x + (p.x - this.last.x) * a, y: this.last.y + (p.y - this.last.y) * a };
    return { x: this.last.x, y: this.last.y, jumped: false };
  }
}

// ---------------------------------------------------------------- collision
/** Swept test: does segment A->B come within r of circle centre C? Catches fast swipes. */
export function segmentHitsCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((cx - ax) * dx + (cy - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  const px = ax + dx * t, py = ay + dy * t;
  return (cx - px) ** 2 + (cy - py) ** 2 <= r * r;
}

// ---------------------------------------------------------------- scoring
export class ScoreManager {
  constructor(cfg = CONFIG.score) { this.cfg = cfg; this.reset(); }
  reset() {
    this.score = 0; this.combo = 0; this.bestCombo = 0; this.sliced = 0;
    this.lastSliceT = -Infinity; this.swipe = -1; this.swipeCount = 0;
  }
  multiplier() {
    return Math.min(this.cfg.maxMultiplier, 1 + Math.floor(this.combo / this.cfg.multiplierEvery));
  }
  /** Call exactly once per sliced fruit. */
  slice(base, t, swipeId) {
    if (t - this.lastSliceT > this.cfg.comboWindow) this.combo = 0;
    this.combo++;
    this.lastSliceT = t;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    if (swipeId !== this.swipe) { this.swipe = swipeId; this.swipeCount = 0; }
    this.swipeCount++;
    const swipeBonus = this.swipeCount >= 3 ? this.cfg.swipeBonus * (this.swipeCount - 2) : 0;
    const mult = this.multiplier();
    const pts = base * mult + swipeBonus;
    this.score += pts;
    this.sliced++;
    return { pts, combo: this.combo, mult, swipeCount: this.swipeCount, swipeBonus };
  }
  expire(t) { if (t - this.lastSliceT > this.cfg.comboWindow) this.combo = 0; }
  breakCombo() { this.combo = 0; }
  add(n) { this.score += n; }
  penalty(n) { this.score = Math.max(0, this.score - n); }
}

/** One bomb-clear charge with a visible cooldown. Time is game time, so pausing freezes it. */
export class BombCharge {
  constructor(cooldown = CONFIG.bombCooldown) { this.cooldown = cooldown; this.remaining = 0; }
  reset() { this.remaining = 0; }
  update(dt) { this.remaining = Math.max(0, this.remaining - dt); }
  get ready() { return this.remaining <= 0; }
  get progress() { return 1 - this.remaining / this.cooldown; }
  tryUse() {
    if (!this.ready) return false;
    this.remaining = this.cooldown;
    return true;
  }
}

// ---------------------------------------------------------------- state machine
export const TRANSITIONS = {
  MENU: ['SETUP', 'COUNTDOWN'],
  SETUP: ['CALIBRATING', 'COUNTDOWN', 'MENU', 'ERROR'],
  ERROR: ['SETUP', 'MENU', 'COUNTDOWN'],
  CALIBRATING: ['COUNTDOWN', 'MENU', 'ERROR'],
  COUNTDOWN: ['PLAYING', 'MENU', 'ERROR'],
  PLAYING: ['PAUSED', 'GAME_OVER', 'MENU', 'COUNTDOWN', 'ERROR'],
  PAUSED: ['PLAYING', 'COUNTDOWN', 'MENU', 'GAME_OVER', 'ERROR'],
  GAME_OVER: ['COUNTDOWN', 'MENU', 'SETUP'],
};

export class StateMachine {
  constructor(initial = 'MENU', onChange = () => {}) { this.state = initial; this.onChange = onChange; }
  can(next) { return (TRANSITIONS[this.state] || []).includes(next); }
  go(next) {
    if (!this.can(next)) return false;
    const prev = this.state;
    this.state = next;
    this.onChange(next, prev);
    return true;
  }
}

// ---------------------------------------------------------------- storage
export const SAVE_KEY = 'gesture-fruit-ninja:v1';
export const defaultSave = () => ({
  best: { time: 0, zen: 0, endless: 0 }, calibrated: false, sound: true, volume: 0.7, hintSeen: false,
});

export function loadSave(storage) {
  const base = defaultSave();
  try {
    const raw = storage && storage.getItem(SAVE_KEY);
    if (!raw) return base;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return base;
    for (const k of Object.keys(base.best)) if (Number.isFinite(o.best?.[k])) base.best[k] = Math.max(0, o.best[k]);
    if (typeof o.calibrated === 'boolean') base.calibrated = o.calibrated;
    if (typeof o.sound === 'boolean') base.sound = o.sound;
    if (typeof o.hintSeen === 'boolean') base.hintSeen = o.hintSeen;
    if (Number.isFinite(o.volume)) base.volume = clamp(o.volume, 0, 1);
    return base;
  } catch { return base; }
}

export function writeSave(storage, data) {
  try { storage.setItem(SAVE_KEY, JSON.stringify(data)); return true; } catch { return false; }
}

// ---------------------------------------------------------------- camera helpers
export function classifyCameraError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { code: 'denied', message: 'Camera permission was blocked. Allow camera access in the address bar, then retry. Webcams only work on HTTPS or localhost.' };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return { code: 'missing', message: 'No usable camera was found. Plug one in, or play with mouse or touch.' };
  }
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
    return { code: 'busy', message: 'The camera is in use by another app. Close it and retry.' };
  }
  if (err && err.code === 'unsupported') {
    return { code: 'unsupported', message: 'This browser cannot access a camera here. Use HTTPS or localhost, or play with mouse or touch.' };
  }
  if (err && err.code === 'model') {
    return { code: 'model', message: 'The hand-tracking model could not load. Check your connection and retry.' };
  }
  return { code: 'unknown', message: 'The camera could not start. Retry, or play with mouse or touch.' };
}

export function releaseStream(stream) {
  if (!stream) return 0;
  let n = 0;
  for (const t of stream.getTracks()) { try { t.stop(); n++; } catch { /* ignore */ } }
  return n;
}
