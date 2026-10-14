import {
  CONFIG, MODES, FRUIT_TYPES, FRUIT_POINTS, clamp, lerp, classifyHand, GestureStabilizer, PointSmoother,
  mapToArena, segmentHitsCircle, ScoreManager, BombCharge, StateMachine, loadSave, writeSave,
  classifyCameraError, releaseStream,
} from './logic.js';

/* =====================================================================
   Config: MediaPipe runtime and model are pinned. The model is tried from
   ./models first (offline), then the official Google bucket.
   ===================================================================== */
const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URLS = [
  './models/hand_landmarker.task',
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
];

const $ = (id) => document.getElementById(id);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const rand = (a, b) => a + Math.random() * (b - a);

/* ---------------- persistence ---------------- */
let storage = null;
try { storage = window.localStorage; } catch { storage = null; }
const save = loadSave(storage);
const persist = () => writeSave(storage, save);

/* ---------------- state ---------------- */
let inputMode = 'camera'; // 'camera' | 'pointer'
let modeId = 'time';
const sm = new StateMachine('MENU', (s) => applyState(s));
const score = new ScoreManager();
const bomb = new BombCharge();
const stab = new GestureStabilizer();
const smoother = new PointSmoother();

const game = {
  mode: MODES.time, elapsed: 0, remaining: 60, fruits: [], halves: [], queue: [], waveT: 0.6,
  launched: 0, cleared: 0, bombHits: 0, finishing: false, finishT: 0, nextId: 1, countT: 0, countN: 3,
};
const blade = { last: null, lastT: 0, swipe: 0, armFrames: 0, trail: [] };
const fx = { shake: 0, slow: 0, shockwaves: [], flash: 0 };
let W = 0, H = 0, DPR = 1, quality = 1, displayScore = 0;

/* =====================================================================
   Audio: procedural Web Audio, created only after a user gesture.
   ===================================================================== */
const audio = {
  ctx: null, master: null, noiseBuf: null, enabled: save.sound, vol: save.volume,
  unlock() {
    if (!this.ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.vol;
        this.master.connect(this.ctx.destination);
      } catch { this.ctx = null; }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  },
  setVol(v) { this.vol = v; if (this.master) this.master.gain.value = v; },
  tone(f, d, { type = 'sine', vol = 0.2, to = null, delay = 0 } = {}) {
    if (!this.enabled || !this.ctx) return;
    try {
      const t0 = this.ctx.currentTime + delay;
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t0);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + d);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.connect(g); g.connect(this.master); o.start(t0); o.stop(t0 + d + 0.02);
    } catch { /* never crash gameplay on audio */ }
  },
  noise(d, { vol = 0.2, freq = 1500, to = null, q = 0.8, delay = 0, type = 'bandpass' } = {}) {
    if (!this.enabled || !this.ctx) return;
    try {
      if (!this.noiseBuf) {
        const n = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, n, n);
        const ch = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < n; i++) ch[i] = Math.random() * 2 - 1;
      }
      const t0 = this.ctx.currentTime + delay;
      const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf;
      const f = this.ctx.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(freq, t0);
      if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + d);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      s.connect(f); f.connect(g); g.connect(this.master); s.start(t0, Math.random() * 0.5); s.stop(t0 + d + 0.02);
    } catch { /* ignore */ }
  },
  ui() { this.tone(520, 0.07, { type: 'triangle', vol: 0.12, to: 780 }); },
  count() { this.tone(440, 0.12, { type: 'square', vol: 0.08 }); },
  start() { [523, 659, 784].forEach((f, i) => this.tone(f, 0.18, { type: 'triangle', vol: 0.14, delay: i * 0.08 })); },
  launch() { this.noise(0.18, { vol: 0.05, freq: 400, to: 1400, q: 0.6 }); },
  slice(combo = 1) {
    const k = 1 + Math.min(combo, 12) * 0.04;
    this.noise(0.14, { vol: 0.18, freq: 3200 * k, to: 900, q: 0.9 });
    this.tone(620 * k, 0.1, { type: 'triangle', vol: 0.1, to: 260 });
  },
  comboHit(n) { [660, 830, 990, 1320].forEach((f, i) => this.tone(f * (1 + n * 0.002), 0.12, { type: 'triangle', vol: 0.12, delay: i * 0.05 })); },
  bombClear() { this.tone(110, 0.7, { type: 'sine', vol: 0.4, to: 38 }); this.noise(0.6, { vol: 0.3, freq: 2500, to: 120, q: 0.4, type: 'lowpass' }); },
  bombHit() { this.noise(0.4, { vol: 0.35, freq: 700, to: 80, q: 0.3, type: 'lowpass' }); this.tone(90, 0.35, { type: 'sawtooth', vol: 0.2, to: 40 }); },
  over() { [523, 440, 349, 262].forEach((f, i) => this.tone(f, 0.28, { type: 'triangle', vol: 0.14, delay: i * 0.16 })); },
  setEnabled(on) {
    this.enabled = on; save.sound = on; persist();
    document.querySelectorAll('#btnSound,#btnSoundMenu,#pSound').forEach((b) => b.setAttribute('aria-pressed', String(on)));
    $('btnSoundMenu').textContent = on ? 'Sound on' : 'Sound off';
    $('pSound').textContent = on ? 'Sound on' : 'Sound off';
    $('soundWave').style.display = on ? '' : 'none';
  },
};

/* =====================================================================
   Camera + MediaPipe hand tracking (single inference loop)
   ===================================================================== */
const video = $('video');
const camOverlay = $('camOverlay');
const camCtx = camOverlay.getContext('2d');
let camState = 'Waiting for camera';
function setCamState(s) {
  camState = s;
  $('camStatus').textContent = s;
  $('menuCam').textContent = s === 'Waiting for camera' ? 'not started' : s.toLowerCase();
}

const cam = {
  stream: null, landmarker: null, running: false, raf: 0, lastInfer: 0, lastVT: -1, _p: null, previewOn: true,
  start() {
    if (this.stream && this.landmarker) { this.run(); return Promise.resolve(); }
    if (this._p) return this._p; // never open two cameras
    this._p = this._start().finally(() => { this._p = null; });
    return this._p;
  },
  async _start() {
    setCamState('Initializing');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      const e = new Error('unsupported'); e.code = 'unsupported'; throw e;
    }
    if (!this.stream) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false,
      });
      this.stream = stream;
      stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => onCameraLost()));
      video.srcObject = stream;
      await video.play();
    }
    if (!this.landmarker) {
      try { this.landmarker = await loadLandmarker(); }
      catch (err) { console.warn('Hand model load failed', err); this.stop(); const e = new Error('model'); e.code = 'model'; throw e; }
    }
    setCamState('Ready');
    this.run();
  },
  run() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (now - this.lastInfer < 1000 / CONFIG.inferFps) return;
      if (video.readyState < 2 || video.currentTime === this.lastVT) return;
      this.lastVT = video.currentTime; this.lastInfer = now;
      let res;
      try { res = this.landmarker.detectForVideo(video, now); } catch { return; }
      onHandResult(res, now);
    };
    this.raf = requestAnimationFrame(loop);
  },
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    releaseStream(this.stream);
    this.stream = null;
    video.srcObject = null;
    stab.reset(); smoother.reset(); blade.last = null; blade.armFrames = 0;
    setCamState('Waiting for camera');
    $('cam').hidden = true;
  },
};

async function loadLandmarker() {
  const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  let lastErr;
  for (const url of MODEL_URLS) {
    for (const delegate of ['GPU', 'CPU']) {
      try {
        return await vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: url, delegate },
          runningMode: 'VIDEO', numHands: 1,
          minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('model');
}

function onCameraLost() {
  if (!cam.stream) return;
  cam.stop();
  showSetupError({ code: 'lost', message: 'The camera disconnected. Reconnect it and retry, or play with mouse or touch.' });
  sm.go('ERROR');
}

let noHandFrames = 0;
const calibDone = new Set();
function onHandResult(res, now) {
  const lms = res && res.landmarks;
  if (!lms || !lms.length) {
    noHandFrames++;
    if (noHandFrames >= CONFIG.gesture.stableFrames.NO_HAND) {
      const r = stab.update('NO_HAND');
      noHandFrames = CONFIG.gesture.stableFrames.NO_HAND;
      blade.armFrames = 0; smoother.reset(); releaseBlade();
      if (cam.stream) setCamState('Ready');
      updateGestureUI(r.stable);
      drawCamHand(null);
    }
    return;
  }
  noHandFrames = 0;
  setCamState('Tracking hand');
  const lm = lms[0];
  const info = classifyHand(lm);
  const { stable, entered } = stab.update(info.gesture);
  updateGestureUI(stable);
  drawCamHand(lm);

  if (sm.state === 'CALIBRATING') {
    $('calibNow').textContent = labelFor(stable);
    if (entered && ['INDEX_POINTING', 'FIST', 'OPEN_PALM'].includes(entered) && !calibDone.has(entered)) {
      calibDone.add(entered);
      document.querySelector(`#calib li[data-g="${entered}"]`).classList.add('done');
      audio.ui();
      if (calibDone.size === 3) $('calibStart').disabled = false;
    }
    return;
  }

  if (sm.state === 'PLAYING' && !game.finishing) {
    if (entered === 'OPEN_PALM') { pauseGame(); return; }
    if (entered === 'FIST') bombClear();
  }

  // Blade: index finger extended, and not a fist/palm. Needs a few stable frames after (re)acquiring.
  const bladeOk = info.gesture === 'INDEX_POINTING' || (info.gesture === 'OTHER_GESTURE' && info.indexExtended && blade.armFrames >= CONFIG.gesture.armFrames);
  if (bladeOk) {
    blade.armFrames++;
    if (blade.armFrames >= CONFIG.gesture.armFrames) {
      const p = mapToArena(lm[8], W, H);
      const s = smoother.update(p, now, W, H);
      if (s.jumped) releaseBlade();
      if (sm.state === 'PLAYING' || sm.state === 'COUNTDOWN') bladeMove(s.x, s.y, now, sm.state === 'PLAYING' && !game.finishing);
    }
  } else {
    blade.armFrames = 0; smoother.reset(); releaseBlade();
  }
}

const LABELS = {
  NO_HAND: '\u2013 No hand detected', INDEX_POINTING: '\u25B2 Point to slice', FIST: '\u25CF Fist recognized',
  OPEN_PALM: '\u2726 Palm recognized', OTHER_GESTURE: '\u25C7 Hand detected',
};
const labelFor = (g) => LABELS[g].slice(2);
function updateGestureUI(g) {
  if (inputMode !== 'camera') return;
  const el = $('gesture');
  if (el.dataset.g !== g) { el.dataset.g = g; el.textContent = LABELS[g]; }
}

const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
function drawCamHand(lm) {
  if (!cam.previewOn) return;
  const w = camOverlay.width, h = camOverlay.height;
  camCtx.clearRect(0, 0, w, h);
  if (!lm) return;
  camCtx.strokeStyle = 'rgba(34,211,238,.9)'; camCtx.lineWidth = 2;
  camCtx.beginPath();
  for (const [a, b] of HAND_LINKS) { camCtx.moveTo(lm[a].x * w, lm[a].y * h); camCtx.lineTo(lm[b].x * w, lm[b].y * h); }
  camCtx.stroke();
  camCtx.fillStyle = '#FF4D6D'; camCtx.beginPath(); camCtx.arc(lm[8].x * w, lm[8].y * h, 4, 0, 7); camCtx.fill();
}

/* =====================================================================
   Fruit art (procedural vector drawing)
   ===================================================================== */
const ART = {
  watermelon: { flesh: '#FF4D6D', rind: '#A3E635', juice: '#FF4D6D', k: 1.2 },
  orange: { flesh: '#FFC266', rind: '#FF8A1F', juice: '#FFAA33', k: 1 },
  apple: { flesh: '#F6EBC8', rind: '#E0243F', juice: '#F5E6A8', k: 1 },
  strawberry: { flesh: '#FF7C92', rind: '#E0183A', juice: '#FF4D6D', k: 0.9 },
  pineapple: { flesh: '#FFE066', rind: '#E8A317', juice: '#FFD93D', k: 1.05 },
  lemon: { flesh: '#F6F7A0', rind: '#F2D91B', juice: '#E6F26B', k: 0.95 },
  peach: { flesh: '#FFC2A3', rind: '#FF9A76', juice: '#FF9A76', k: 0.98 },
  coconut: { flesh: '#F8F5EE', rind: '#6B4423', juice: '#F1EFE6', k: 1.05 },
};

function rg(ctx, r, c0, c1, c2) {
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.05);
  g.addColorStop(0, c0); g.addColorStop(0.6, c1); g.addColorStop(1, c2);
  return g;
}
function leaf(ctx, x, y, len, ang, col) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.fillStyle = col;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(len * 0.5, -len * 0.45, len, 0); ctx.quadraticCurveTo(len * 0.5, len * 0.35, 0, 0); ctx.fill(); ctx.restore();
}
function drawBody(ctx, t, r) {
  switch (t) {
    case 'watermelon': {
      ctx.fillStyle = rg(ctx, r, '#8EE07A', '#2E9A4B', '#14532D'); ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.clip();
      ctx.strokeStyle = 'rgba(8,60,30,.55)'; ctx.lineWidth = r * 0.1;
      for (const k of [-0.62, -0.25, 0.25, 0.62]) {
        const y = Math.sqrt(1 - k * k) * r; ctx.beginPath(); ctx.moveTo(k * r, -y); ctx.quadraticCurveTo(k * r * 1.6, 0, k * r, y); ctx.stroke();
      }
      ctx.restore(); break;
    }
    case 'orange': {
      ctx.fillStyle = rg(ctx, r, '#FFD27A', '#FF9A1F', '#D9650A'); ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(160,70,0,.25)';
      for (let i = 0; i < 14; i++) { const a = i * 2.4, d = r * (0.25 + (i % 5) * 0.14); ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r * 0.025, 0, 7); ctx.fill(); }
      leaf(ctx, 0, -r * 0.92, r * 0.5, -0.5, '#58B034'); break;
    }
    case 'apple': {
      ctx.fillStyle = rg(ctx, r, '#FF7A85', '#E0243F', '#8E1028'); ctx.beginPath(); ctx.arc(0, r * 0.05, r * 0.98, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(9,11,22,.35)'; ctx.beginPath(); ctx.ellipse(0, -r * 0.88, r * 0.22, r * 0.12, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = '#6B4423'; ctx.lineWidth = r * 0.07; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(0, -r * 0.85); ctx.lineTo(r * 0.06, -r * 1.15); ctx.stroke();
      leaf(ctx, r * 0.06, -r * 1.05, r * 0.5, -0.4, '#7FC93A'); break;
    }
    case 'strawberry': {
      ctx.fillStyle = rg(ctx, r, '#FF7C92', '#E0183A', '#8A0E26');
      ctx.beginPath(); ctx.moveTo(0, r * 1.05); ctx.bezierCurveTo(-r * 1.25, r * 0.25, -r * 1.05, -r * 0.95, 0, -r * 0.8); ctx.bezierCurveTo(r * 1.05, -r * 0.95, r * 1.25, r * 0.25, 0, r * 1.05); ctx.fill();
      ctx.fillStyle = '#FFE98A';
      for (let i = 0; i < 12; i++) { const x = ((i * 37) % 100) / 100 - 0.5, y = ((i * 53) % 100) / 100 - 0.35; ctx.beginPath(); ctx.ellipse(x * r * 1.4, y * r * 1.5, r * 0.035, r * 0.055, 0, 0, 7); ctx.fill(); }
      for (let i = -2; i <= 2; i++) leaf(ctx, 0, -r * 0.8, r * 0.55, -Math.PI / 2 + i * 0.5, '#5DBE3A'); break;
    }
    case 'pineapple': {
      ctx.save(); ctx.scale(0.82, 1);
      ctx.fillStyle = rg(ctx, r, '#FFE066', '#F0A51B', '#B86A0A'); ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
      ctx.clip(); ctx.strokeStyle = 'rgba(120,60,0,.45)'; ctx.lineWidth = r * 0.04;
      for (let i = -6; i <= 6; i++) { ctx.beginPath(); ctx.moveTo(i * r * 0.3 - r, -r); ctx.lineTo(i * r * 0.3 + r, r); ctx.moveTo(i * r * 0.3 + r, -r); ctx.lineTo(i * r * 0.3 - r, r); ctx.stroke(); }
      ctx.restore();
      for (let i = -3; i <= 3; i++) leaf(ctx, 0, -r * 0.92, r * 0.8, -Math.PI / 2 + i * 0.32, i % 2 ? '#3FA83A' : '#5DBE3A'); break;
    }
    case 'lemon': {
      ctx.fillStyle = rg(ctx, r, '#FFF59A', '#F2D91B', '#C2A30C');
      ctx.beginPath(); ctx.moveTo(-r * 1.08, 0); ctx.bezierCurveTo(-r * 0.7, -r * 1.05, r * 0.7, -r * 1.05, r * 1.08, 0); ctx.bezierCurveTo(r * 0.7, r * 1.05, -r * 0.7, r * 1.05, -r * 1.08, 0); ctx.fill(); break;
    }
    case 'peach': {
      ctx.fillStyle = rg(ctx, r, '#FFD7B8', '#FF9A76', '#E0556B'); ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(160,40,60,.35)'; ctx.lineWidth = r * 0.06; ctx.beginPath(); ctx.arc(-r * 0.25, 0, r * 0.85, -1.2, 1.2); ctx.stroke();
      leaf(ctx, 0, -r * 0.92, r * 0.55, -0.6, '#6CC04A'); break;
    }
    case 'coconut': {
      ctx.fillStyle = rg(ctx, r, '#9A6A3F', '#6B4423', '#33200F'); ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(30,15,5,.4)'; ctx.lineWidth = 1.5;
      for (let i = 0; i < 18; i++) { const a = i * 0.7; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3); ctx.lineTo(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95); ctx.stroke(); }
      ctx.fillStyle = '#26160A'; for (const [x, y] of [[-0.2, -0.45], [0.2, -0.45], [0, -0.2]]) { ctx.beginPath(); ctx.arc(x * r, y * r, r * 0.09, 0, 7); ctx.fill(); }
      break;
    }
  }
}
function drawBomb(ctx, r, pulse) {
  ctx.strokeStyle = `rgba(255,77,109,${0.5 + pulse * 0.5})`; ctx.lineWidth = r * 0.12;
  ctx.beginPath(); ctx.arc(0, 0, r * 1.12, 0, 7); ctx.stroke();
  ctx.fillStyle = rg(ctx, r, '#5b6078', '#1a1d2e', '#05060c'); ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
  ctx.fillStyle = '#2b2f45'; ctx.fillRect(-r * 0.22, -r * 1.12, r * 0.44, r * 0.28);
  ctx.strokeStyle = '#c9a66b'; ctx.lineWidth = r * 0.07; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, -r * 1.1); ctx.quadraticCurveTo(r * 0.3, -r * 1.4, r * 0.5, -r * 1.25); ctx.stroke();
  ctx.fillStyle = pulse > 0.5 ? '#FFAA33' : '#FF4D6D'; ctx.beginPath(); ctx.arc(r * 0.5, -r * 1.27, r * 0.1, 0, 7); ctx.fill();
  ctx.strokeStyle = '#FF4D6D'; ctx.lineWidth = r * 0.12; ctx.beginPath();
  ctx.moveTo(-r * 0.3, -r * 0.1); ctx.lineTo(r * 0.3, r * 0.5); ctx.moveTo(r * 0.3, -r * 0.1); ctx.lineTo(-r * 0.3, r * 0.5); ctx.stroke();
}
function drawHalf(ctx, t, r, side) {
  const a = ART[t];
  ctx.save(); ctx.beginPath(); ctx.rect(side < 0 ? -r * 2 : 0, -r * 2, r * 2, r * 4); ctx.clip();
  drawBody(ctx, t, r);
  ctx.fillStyle = a.rind; ctx.beginPath(); ctx.ellipse(0, 0, r * 0.2, r * 0.98, 0, 0, 7); ctx.fill();
  ctx.fillStyle = a.flesh; ctx.beginPath(); ctx.ellipse(0, 0, r * 0.14, r * 0.88, 0, 0, 7); ctx.fill();
  ctx.restore();
}

/* =====================================================================
   Particles (pooled and capped)
   ===================================================================== */
const POOL = 700;
const parts = Array.from({ length: POOL }, () => ({ on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 3, color: '#fff', spark: false }));
let partCursor = 0;
function emit(x, y, vx, vy, life, size, color, spark = false) {
  const cap = Math.floor(POOL * (quality ? 1 : 0.35));
  for (let tries = 0; tries < 6; tries++) {
    const p = parts[partCursor++ % cap];
    if (!p.on || tries === 5) { Object.assign(p, { on: true, x, y, vx, vy, life, max: life, size, color, spark }); return; }
  }
}
const texts = Array.from({ length: 24 }, () => ({ on: false, x: 0, y: 0, vy: 0, life: 0, max: 1, text: '', color: '#fff', size: 24 }));
let textCursor = 0;
function floatText(x, y, text, color = '#F8FAFC', size = 24, life = 0.9) {
  Object.assign(texts[textCursor++ % texts.length], { on: true, x, y, vy: -60, life, max: life, text, color, size });
}
function juiceBurst(x, y, color, n, power) {
  const k = reduced ? 0.5 : 1;
  for (let i = 0; i < n * k; i++) {
    const a = rand(0, 6.283), s = rand(0.2, 1) * power;
    emit(x, y, Math.cos(a) * s, Math.sin(a) * s - power * 0.2, rand(0.4, 0.9), rand(2, 5.5), color);
  }
  for (let i = 0; i < 6 * k; i++) { const a = rand(0, 6.283), s = rand(0.6, 1.2) * power; emit(x, y, Math.cos(a) * s, Math.sin(a) * s, rand(0.15, 0.3), 2, '#FFFFFF', true); }
}

/* =====================================================================
   Engine
   ===================================================================== */
const unit = () => Math.min(W, H);
const fruitRadius = () => clamp(unit() * 0.075, 32, 72);
const gravity = () => H * 1.5 * game.mode.gravity;

function resetGame() {
  const m = MODES[modeId];
  Object.assign(game, {
    mode: m, elapsed: 0, remaining: m.duration ?? 0, fruits: [], halves: [], queue: [], waveT: 0.5, launched: 0, cleared: 0,
    bombHits: 0, finishing: false, finishT: 0,
  });
  score.reset(); bomb.reset(); displayScore = 0;
  parts.forEach((p) => { p.on = false; }); texts.forEach((t) => { t.on = false; });
  fx.shake = 0; fx.slow = 0; fx.shockwaves.length = 0; fx.flash = 0;
  blade.trail.length = 0; blade.last = null; blade.armFrames = 0; blade.swipe++;
  stab.reset(); smoother.reset();
}

function launch(item, attract = false) {
  const r = fruitRadius() * (item.bomb ? 0.95 : ART[item.type].k);
  const g = gravity();
  const x = rand(W * 0.12, W * 0.88);
  const apex = H * rand(0.5, 0.86);
  const vy = -Math.sqrt(2 * g * (apex + r));
  const T = (2 * -vy) / g;
  const tx = attract ? rand(W * 0.45, W * 0.95) : rand(W * 0.15, W * 0.85);
  game.fruits.push({
    id: game.nextId++, type: item.type, bomb: item.bomb, x, y: H + r, vx: (tx - x) / T, vy, r,
    rot: rand(0, 6.28), vr: rand(-4, 4), sliced: false, age: 0,
  });
  if (!item.bomb) game.launched++;
  audio.launch();
}

function difficulty() { return clamp(game.elapsed / (game.mode.duration ?? 90), 0, 1); }
function spawnWave() {
  const d = difficulty(), m = game.mode;
  const n = 1 + Math.floor(Math.random() * (2 + d * 3));
  let bombPlaced = false;
  for (let i = 0; i < n; i++) {
    const b = m.bombs && game.elapsed > 4 && n >= 2 && i > 0 && !bombPlaced && Math.random() < lerp(0.18, 0.4, d);
    if (b) bombPlaced = true;
    game.queue.push({ at: game.elapsed + i * 0.15, bomb: b, type: FRUIT_TYPES[(Math.random() * FRUIT_TYPES.length) | 0] });
  }
  game.waveT = lerp(1.7, 0.9, d) * m.interval;
}

function stepWorld(dt, spawning) {
  const g = gravity();
  if (spawning) {
    game.waveT -= dt;
    if (game.waveT <= 0) spawnWave();
    for (let i = game.queue.length - 1; i >= 0; i--) {
      if (game.queue[i].at <= game.elapsed) { launch(game.queue[i]); game.queue.splice(i, 1); }
    }
  }
  const fs = game.fruits; let w = 0;
  for (let i = 0; i < fs.length; i++) {
    const f = fs[i];
    f.vy += g * dt; f.x += f.vx * dt; f.y += f.vy * dt; f.rot += f.vr * dt; f.age += dt;
    if (!((f.y > H + f.r * 2 && f.vy > 0) || f.x < -f.r * 3 || f.x > W + f.r * 3)) fs[w++] = f;
  }
  fs.length = w;
  const hs = game.halves; w = 0;
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i];
    h.vy += g * dt; h.x += h.vx * dt; h.y += h.vy * dt; h.rot += h.vr * dt;
    if (h.y < H + h.r * 2) hs[w++] = h;
  }
  hs.length = w;
}

function spawnHalves(f, angle) {
  const nx = -Math.sin(angle), ny = Math.cos(angle);
  for (const side of [-1, 1]) {
    game.halves.push({
      type: f.type, r: f.r, x: f.x, y: f.y, vx: f.vx * 0.6 + nx * side * 140, vy: f.vy * 0.5 + ny * side * 140 - 60,
      rot: f.rot + angle, vr: side * rand(1.5, 4), side,
    });
  }
}

function sliceFruit(f, angle) {
  f.sliced = true;
  const res = score.slice(FRUIT_POINTS[f.type], game.elapsed, blade.swipe);
  spawnHalves(f, angle);
  juiceBurst(f.x, f.y, ART[f.type].juice, 16, unit() * 0.7);
  floatText(f.x, f.y - f.r, `+${res.pts}`, res.mult > 1 ? '#FFAA33' : '#F8FAFC', 26);
  audio.slice(res.combo);
  if (res.combo > 0 && res.combo % 5 === 0) {
    floatText(W / 2, H * 0.3, `COMBO x${res.combo}`, '#22D3EE', 44, 1.1);
    audio.comboHit(res.combo);
    if (!reduced) fx.slow = 0.14;
  }
  if (res.swipeBonus > 0) floatText(f.x, f.y + f.r * 0.6, `Swipe bonus +${res.swipeBonus}`, '#A3E635', 18);
}

function hitBomb(b) {
  b.sliced = true;
  juiceBurst(b.x, b.y, '#FF4D6D', 26, unit() * 0.9);
  score.penalty(CONFIG.score.bombPenalty); score.breakCombo();
  game.bombHits++;
  floatText(b.x, b.y, `-${CONFIG.score.bombPenalty}`, '#FF4D6D', 34, 1.1);
  fx.flash = 0.35; if (!reduced) fx.shake = 0.5;
  audio.bombHit();
  if (game.mode.lives && game.bombHits >= game.mode.lives) beginFinish();
}

function bombClear() {
  if (sm.state !== 'PLAYING' || game.finishing) return;
  const targets = game.fruits.filter((f) => !f.sliced);
  if (!targets.length) { toast('Nothing to clear yet'); return; }
  if (!bomb.tryUse()) return;
  fx.shockwaves.push({ t: 0 });
  if (!reduced) fx.shake = 0.8;
  let pts = 0;
  for (const f of targets) {
    f.sliced = true;
    if (f.bomb) { juiceBurst(f.x, f.y, '#22D3EE', 10, unit() * 0.6); continue; }
    pts += CONFIG.score.bombClearPerFruit; game.cleared++;
    spawnHalves(f, rand(0, 3.14));
    juiceBurst(f.x, f.y, ART[f.type].juice, 12, unit() * 0.8);
  }
  score.add(pts);
  for (let i = 0; i < 70; i++) { const a = rand(0, 6.283), s = rand(0.3, 1.4) * unit(); emit(W / 2, H / 2, Math.cos(a) * s, Math.sin(a) * s, rand(0.3, 0.8), rand(2, 4), '#22D3EE', true); }
  floatText(W / 2, H * 0.42, 'BOMB CLEAR!', '#FFAA33', 52, 1.3);
  if (pts) floatText(W / 2, H * 0.52, `+${pts}`, '#F8FAFC', 30, 1.1);
  audio.bombClear();
}

/* ---- blade ---- */
function releaseBlade() { if (blade.last) blade.swipe++; blade.last = null; }
function bladeMove(x, y, now, canSlice) {
  const prev = blade.last;
  blade.trail.push({ x, y, t: now });
  if (blade.trail.length > 40) blade.trail.shift();
  if (prev && canSlice) {
    const dt = Math.max(0.008, (now - blade.lastT) / 1000);
    const len = Math.hypot(x - prev.x, y - prev.y);
    if (len / dt >= unit() * 0.22) { // must actually be swiping
      const angle = Math.atan2(y - prev.y, x - prev.x);
      for (const f of game.fruits) {
        if (f.sliced) continue;
        if (segmentHitsCircle(prev.x, prev.y, x, y, f.x, f.y, f.r * 0.95 + 6)) {
          if (f.bomb) hitBomb(f); else sliceFruit(f, angle);
        }
      }
    }
  }
  blade.last = { x, y }; blade.lastT = now;
}

/* ---- round lifecycle ---- */
function beginRound() {
  audio.unlock();
  resetGame();
  game.countN = 3; game.countT = 0;
  sm.go('COUNTDOWN');
}
function beginFinish() {
  if (game.finishing) return;
  game.finishing = true; game.finishT = 0.9; releaseBlade();
}
function endRound() {
  if (!sm.go('GAME_OVER')) return;
  audio.over();
  const prevBest = save.best[modeId];
  const isBest = score.score > prevBest;
  if (isBest) { save.best[modeId] = score.score; persist(); }
  $('oScore').textContent = score.score;
  $('oBest').textContent = save.best[modeId];
  $('oSliced').textContent = `${score.sliced} / ${game.launched}`;
  $('oSlicedLbl').textContent = 'Fruit sliced of launched';
  $('oCombo').textContent = score.bestCombo;
  $('oCleared').textContent = game.cleared;
  $('oNew').hidden = !(isBest && score.score > 0);
}
function pauseGame() {
  if (sm.state !== 'PLAYING' || game.finishing) return;
  if (!sm.go('PAUSED')) return;
  releaseBlade(); blade.armFrames = 0; smoother.reset();
  audio.ui();
}
function resumeGame() {
  if (!sm.go('PLAYING')) return;
  blade.armFrames = 0; smoother.reset(); blade.last = null; // re-acquire before slicing
  audio.ui();
}
function toMenu() {
  releaseBlade();
  resetGame();
  sm.go('MENU');
}

/* =====================================================================
   Frame loop
   ===================================================================== */
let lastTs = 0, slowAvg = 16, attractBlade = null, attractT = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const real = Math.min(0.05, (ts - lastTs) / 1000 || 0.016);
  lastTs = ts;
  slowAvg = slowAvg * 0.95 + real * 1000 * 0.05;
  if (slowAvg > 26 && quality) quality = 0; // graceful quality drop: fewer particles, no glow blur

  let dt = real;
  if (fx.slow > 0) { fx.slow -= real; dt = real * 0.35; }
  const s = sm.state;

  if (s === 'MENU') attract(dt);
  else if (s === 'COUNTDOWN') {
    game.countT += real;
    const n = 3 - Math.floor(game.countT / 0.8);
    if (n !== game.countN || game.countT === real) {
      game.countN = n;
      if (n >= 1) { $('cdNum').textContent = n; audio.count(); } else if (n === 0) { $('cdNum').textContent = 'GO!'; audio.start(); }
      $('cdNum').style.animation = 'none'; void $('cdNum').offsetWidth; $('cdNum').style.animation = '';
    }
    if (game.countT >= 3.2) { sm.go('PLAYING'); blade.armFrames = 0; maybeHint(); }
  } else if (s === 'PLAYING') {
    game.elapsed += real;
    bomb.update(real);
    score.expire(game.elapsed);
    if (!game.finishing) {
      stepWorld(dt, true);
      if (game.mode.duration) { game.remaining = Math.max(0, game.mode.duration - game.elapsed); if (game.remaining <= 0) beginFinish(); }
    } else {
      stepWorld(dt, false);
      game.finishT -= real;
      if (game.finishT <= 0) endRound();
    }
  }
  stepParticles(dt);
  render(real);
  updateHUD(real);
}

function stepParticles(dt) {
  const g = H * 1.2;
  for (const p of parts) {
    if (!p.on) continue;
    p.life -= dt; if (p.life <= 0) { p.on = false; continue; }
    if (!p.spark) p.vy += g * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
  }
  for (const t of texts) { if (!t.on) continue; t.life -= dt; if (t.life <= 0) { t.on = false; continue; } t.y += t.vy * dt; }
  for (let i = fx.shockwaves.length - 1; i >= 0; i--) { fx.shockwaves[i].t += dt; if (fx.shockwaves[i].t > 0.8) fx.shockwaves.splice(i, 1); }
  fx.shake = Math.max(0, fx.shake - dt * 2.2);
  fx.flash = Math.max(0, fx.flash - dt);
}

/* attract mode on the landing screen: decorative only, never touches score/save */
function attract(dt) {
  attractT += dt;
  game.elapsed += dt;
  if (attractT > 1.15) {
    attractT = 0;
    launch({ bomb: false, type: FRUIT_TYPES[(Math.random() * FRUIT_TYPES.length) | 0] }, true);
    game.launched = 0;
  }
  stepWorld(dt, false);
  if (!attractBlade) {
    const f = game.fruits.find((q) => !q.sliced && q.age > 0.55 && q.y < H * 0.8 && q.x > 0 && q.x < W);
    if (f) attractBlade = { f, p: 0, ang: rand(-0.9, -0.3), dir: Math.random() < 0.5 ? 1 : -1 };
  } else {
    const a = attractBlade; a.p += dt * 6;
    const f = a.f, L = f.r * 3.2;
    const px = f.x + Math.cos(a.ang) * (a.p - 0.5) * L * a.dir, py = f.y + Math.sin(a.ang) * (a.p - 0.5) * L * a.dir;
    blade.trail.push({ x: px, y: py, t: performance.now() });
    if (a.p >= 0.5 && !f.sliced) { f.sliced = true; spawnHalves(f, a.ang); juiceBurst(f.x, f.y, ART[f.type].juice, 14, unit() * 0.6); }
    if (a.p >= 1) attractBlade = null;
  }
}

/* =====================================================================
   Rendering
   ===================================================================== */
const canvas = $('stage');
const ctx = canvas.getContext('2d');
let bgGrad = null;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  bgGrad = ctx.createRadialGradient(W * 0.5, H * 0.35, 0, W * 0.5, H * 0.5, Math.hypot(W, H) * 0.7);
  bgGrad.addColorStop(0, '#1b1f40'); bgGrad.addColorStop(0.55, '#12162A'); bgGrad.addColorStop(1, '#090B16');
}

function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);
  ctx.save();
  if (fx.shake > 0) { const m = fx.shake * 14; ctx.translate(rand(-m, m), rand(-m, m)); }

  for (const sw of fx.shockwaves) {
    const k = sw.t / 0.8, rr = k * Math.hypot(W, H) * 0.6;
    ctx.strokeStyle = `rgba(34,211,238,${1 - k})`; ctx.lineWidth = 18 * (1 - k) + 2;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, rr, 0, 7); ctx.stroke();
    ctx.strokeStyle = `rgba(255,170,51,${(1 - k) * 0.7})`; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, rr * 0.85, 0, 7); ctx.stroke();
  }
  for (const h of game.halves) { ctx.save(); ctx.translate(h.x, h.y); ctx.rotate(h.rot); drawHalf(ctx, h.type, h.r, h.side); ctx.restore(); }
  const pulse = (Math.sin(performance.now() / 120) + 1) / 2;
  for (const f of game.fruits) {
    if (f.sliced) continue;
    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rot);
    if (f.bomb) drawBomb(ctx, f.r, pulse); else drawBody(ctx, f.type, f.r);
    ctx.restore();
  }

  ctx.globalCompositeOperation = 'lighter';
  for (const p of parts) {
    if (!p.on) continue;
    const a = clamp(p.life / p.max, 0, 1);
    ctx.globalAlpha = a; ctx.fillStyle = p.color;
    if (p.spark) { ctx.fillRect(p.x - 1, p.y - 1, 3, 3); } else { ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, 7); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  drawTrail();
  ctx.globalCompositeOperation = 'source-over';

  for (const t of texts) {
    if (!t.on) continue;
    const a = clamp(t.life / t.max * 2, 0, 1);
    ctx.globalAlpha = a; ctx.font = `${t.size}px Bungee, Impact, sans-serif`; ctx.textAlign = 'center';
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(9,11,22,.8)'; ctx.strokeText(t.text, t.x, t.y);
    ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  if (fx.flash > 0) $('flash').style.opacity = String(fx.flash); else if ($('flash').style.opacity !== '0') $('flash').style.opacity = '0';
}

const TRAIL_LIFE = 260;
function drawTrail() {
  const now = performance.now();
  const tr = blade.trail;
  while (tr.length && now - tr[0].t > TRAIL_LIFE) tr.shift();
  if (tr.length < 2) return;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < tr.length; i++) {
      const a = tr[i - 1], b = tr[i];
      const k = 1 - (now - b.t) / TRAIL_LIFE;
      if (k <= 0) continue;
      if (b.t - a.t > 120) continue; // gap = separate swipe
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      if (pass === 0) { ctx.strokeStyle = `rgba(139,92,246,${0.35 * k})`; ctx.lineWidth = 26 * k; }
      else if (pass === 1) { ctx.strokeStyle = `rgba(34,211,238,${0.7 * k})`; ctx.lineWidth = 11 * k; }
      else { ctx.strokeStyle = `rgba(255,255,255,${k})`; ctx.lineWidth = 4.5 * k; }
      if (quality && pass === 1) { ctx.shadowColor = '#22D3EE'; ctx.shadowBlur = 14; } else ctx.shadowBlur = 0;
      ctx.stroke();
    }
  }
  ctx.shadowBlur = 0;
}

/* =====================================================================
   HUD / UI
   ===================================================================== */
const hud = { score: -1, time: '', combo: '', bar: -1, bomb: '' };
function updateHUD(real) {
  if (sm.state === 'MENU' || sm.state === 'GAME_OVER') return;
  displayScore += (score.score - displayScore) * Math.min(1, real * 12);
  const ds = Math.round(displayScore);
  if (ds !== hud.score) { hud.score = ds; $('hScore').textContent = ds; }
  const timed = !!game.mode.duration;
  const t = timed ? Math.ceil(game.remaining) : Math.floor(game.elapsed);
  const ts = String(t);
  if (ts !== hud.time) { hud.time = ts; $('hTime').textContent = timed ? ts : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }
  const bar = timed ? game.remaining / game.mode.duration : 1;
  if (Math.abs(bar - hud.bar) > 0.004) { hud.bar = bar; $('timeBar').style.transform = `scaleX(${bar})`; }
  const c = score.combo > 1 ? `Combo x${score.combo}` : '';
  if (c !== hud.combo) { hud.combo = c; $('hCombo').textContent = c; }
  const bt = bomb.ready ? 'Bomb clear ready' : `Bomb clear ${Math.ceil(bomb.remaining)}s`;
  if (bt !== hud.bomb) { hud.bomb = bt; $('bombText').textContent = bt; $('bombBtn').classList.toggle('ready', bomb.ready); }
  $('bombFill').style.transform = `scaleX(${bomb.progress})`;
  if (game.mode.lives) { $('lives').hidden = false; $('lives').textContent = `Bombs left: ${Math.max(0, game.mode.lives - game.bombHits)}`; } else $('lives').hidden = true;
}

let toastT = 0;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2200);
}
function maybeHint() {
  if (save.hintSeen) return;
  save.hintSeen = true; persist();
  const el = $('hint');
  el.textContent = inputMode === 'camera' ? 'Point your index finger and swipe through the fruit.' : 'Move your mouse or finger across the fruit.';
  el.hidden = false; setTimeout(() => { el.hidden = true; }, 5000);
}

function showSetupError(e) {
  const info = e.message && e.code && !e.name ? e : classifyCameraError(e);
  $('setupSpin').hidden = true;
  $('setupTitle').textContent = 'Camera unavailable';
  $('setupMsg').textContent = info.message;
  $('btnRetry').hidden = false; $('btnSetupPointer').hidden = false;
  setCamState('Camera unavailable');
  $('btnRetry').focus();
}

function applyState(s) {
  $('menu').hidden = s !== 'MENU';
  $('setup').hidden = !(s === 'SETUP' || s === 'ERROR');
  $('calib').hidden = s !== 'CALIBRATING';
  $('countdown').hidden = s !== 'COUNTDOWN';
  $('pause').hidden = s !== 'PAUSED';
  $('over').hidden = s !== 'GAME_OVER';
  const inGame = ['COUNTDOWN', 'PLAYING', 'PAUSED'].includes(s);
  $('hud').hidden = !inGame;
  $('hudBottom').hidden = !inGame;
  $('gesture').hidden = inputMode !== 'camera';
  $('cam').hidden = !(cam.stream && s !== 'MENU');
  $('hBest').textContent = save.best[modeId];
  $('menuBest').textContent = save.best[modeId];
  $('pFinish').hidden = !(game.mode.lives || !game.mode.duration);
  if (s !== 'SETUP' && s !== 'ERROR') { $('setupSpin').hidden = false; }
  if (s === 'MENU') { game.fruits.length = 0; game.halves.length = 0; blade.trail.length = 0; attractBlade = null; $('hint').hidden = true; }
  const first = document.querySelector(`#${{ MENU: 'menu', SETUP: 'setup', ERROR: 'setup', CALIBRATING: 'calib', PAUSED: 'pause', GAME_OVER: 'over' }[s]} [data-autofocus]`);
  if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
}

/* =====================================================================
   Wiring
   ===================================================================== */
let setupToken = 0;
async function runCameraSetup() {
  const token = ++setupToken;
  $('setupSpin').hidden = false; $('setupTitle').textContent = 'Starting camera';
  $('setupMsg').textContent = 'Allow camera access when your browser asks. Video stays on your device.';
  $('btnRetry').hidden = true; $('btnSetupPointer').hidden = true;
  try {
    await cam.start();
    if (token !== setupToken || sm.state !== 'SETUP') return;
    $('cam').hidden = false;
    if (save.calibrated) beginRound();
    else { calibDone.clear(); document.querySelectorAll('#calib li').forEach((li) => li.classList.remove('done')); $('calibStart').disabled = true; sm.go('CALIBRATING'); }
  } catch (e) {
    if (token !== setupToken) return;
    showSetupError(classifyCameraError(e));
    sm.go('ERROR');
  }
}
function startFlow() {
  audio.unlock(); audio.ui();
  inputMode = 'camera'; // PLAY NOW always means gesture control; mouse/touch is a separate, labelled button
  if (sm.go('SETUP')) runCameraSetup();
}
function usePointer() {
  audio.unlock(); inputMode = 'pointer';
  cam.stop(); setupToken++;
  beginRound();
}

$('btnPlay').onclick = startFlow;
$('btnHow').onclick = () => { audio.unlock(); audio.ui(); $('howto').hidden = false; $('howStart').focus(); };
$('howClose').onclick = () => { $('howto').hidden = true; $('btnHow').focus(); };
$('howStart').onclick = () => { $('howto').hidden = true; startFlow(); };
$('btnPointer').onclick = usePointer;
$('btnRetry').onclick = () => { audio.ui(); if (sm.go('SETUP') || sm.state === 'SETUP') runCameraSetup(); };
$('btnSetupPointer').onclick = usePointer;
$('btnSetupBack').onclick = () => { setupToken++; sm.go('MENU'); };
$('calibStart').onclick = () => { save.calibrated = true; persist(); beginRound(); };
$('calibSkip').onclick = () => { save.calibrated = true; persist(); beginRound(); };
$('btnPause').onclick = () => { audio.unlock(); pauseGame(); };
$('btnSound').onclick = $('btnSoundMenu').onclick = $('pSound').onclick = () => { audio.unlock(); audio.setEnabled(!audio.enabled); audio.ui(); };
$('pResume').onclick = resumeGame;
$('pRestart').onclick = () => { audio.ui(); beginRound(); };
$('pFinish').onclick = () => { if (sm.go('PLAYING')) beginFinish(); };
$('pMenu').onclick = () => { audio.ui(); toMenu(); };
$('pVol').oninput = (e) => { const v = e.target.value / 100; audio.setVol(v); save.volume = v; persist(); };
$('oAgain').onclick = () => { audio.ui(); beginRound(); };
$('oMenu').onclick = () => { audio.ui(); toMenu(); };
$('bombBtn').onclick = bombClear;
$('btnHideCam').onclick = () => {
  cam.previewOn = !cam.previewOn;
  $('camView').classList.toggle('off', !cam.previewOn);
  $('btnHideCam').textContent = cam.previewOn ? 'Hide preview' : 'Show preview';
};
$('btnStopCam').onclick = () => {
  const wasPlaying = sm.state === 'PLAYING';
  if (wasPlaying) pauseGame();
  cam.stop();
  showSetupError({ code: 'stopped', message: 'Camera stopped. Retry camera to keep playing with gestures, or play with mouse or touch.' });
  $('setupTitle').textContent = 'Camera stopped';
  sm.go('ERROR');
};

document.querySelectorAll('.modes button').forEach((b) => {
  b.onclick = () => {
    modeId = b.dataset.mode; audio.unlock(); audio.ui();
    document.querySelectorAll('.modes button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    $('modeDesc').textContent = MODES[modeId].desc;
    $('menuBest').textContent = save.best[modeId]; $('hBest').textContent = save.best[modeId];
    resetGame();
  };
});

/* pointer / touch fallback (clearly a fallback; gesture tracking is the main path) */
canvas.addEventListener('pointermove', (e) => {
  if (inputMode !== 'pointer') return;
  if (sm.state === 'PLAYING' || sm.state === 'COUNTDOWN') bladeMove(e.clientX, e.clientY, performance.now(), sm.state === 'PLAYING' && !game.finishing);
});
canvas.addEventListener('pointerup', () => releaseBlade());
canvas.addEventListener('pointerleave', () => releaseBlade());
canvas.addEventListener('pointerdown', (e) => { if (inputMode === 'pointer') { blade.last = null; blade.swipe++; canvas.setPointerCapture?.(e.pointerId); } });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('howto').hidden) { $('howClose').click(); return; }
    if (sm.state === 'PLAYING') pauseGame(); else if (sm.state === 'PAUSED') resumeGame();
  } else if (e.key === 'p' || e.key === 'P') {
    if (sm.state === 'PLAYING') pauseGame(); else if (sm.state === 'PAUSED') resumeGame();
  } else if (e.key === 'b' || e.key === 'B') bombClear();
});
document.addEventListener('visibilitychange', () => { if (document.hidden && sm.state === 'PLAYING') pauseGame(); });
window.addEventListener('pagehide', () => { cam.stop(); cam.landmarker?.close?.(); });
window.addEventListener('resize', resize);

/* init */
resize();
audio.setEnabled(save.sound);
$('pVol').value = Math.round(save.volume * 100);
$('modeDesc').textContent = MODES[modeId].desc;
applyState('MENU');
setCamState('Waiting for camera');
requestAnimationFrame(frame);

// Exposed for browser-automation tests only; unused by the game itself.
window.__gfn = { sm, score, game, bomb, get quality() { return quality; } };
