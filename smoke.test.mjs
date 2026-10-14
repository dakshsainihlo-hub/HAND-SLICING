// Headless smoke test: runs the real src/main.js against a stubbed DOM + canvas and drives a whole round
// through the pointer fallback (no camera needed). It does NOT validate webcam or MediaPipe behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';

let now = 0;
const rafs = [];
const els = {};
const listeners = {};
const ctxProxy = new Proxy({}, {
  get: (t, p) => (p === 'createRadialGradient' || p === 'createLinearGradient' ? () => ({ addColorStop() {} }) : p in t ? t[p] : () => {}),
  set: (t, p, v) => { t[p] = v; return true; },
});
function makeEl(id) {
  const t = {
    id, hidden: false, textContent: '', value: '', dataset: {}, style: {}, disabled: false, onclick: null,
    classList: { toggle() {}, add() {}, remove() {} },
    getContext: () => ctxProxy, setAttribute() {}, focus() {}, setPointerCapture() {}, offsetWidth: 0,
    addEventListener(type, fn) { (listeners[`${id}:${type}`] ||= []).push(fn); },
    querySelector: () => makeEl('q'), querySelectorAll: () => [],
  };
  return new Proxy(t, { get: (o, p) => (p in o ? o[p] : () => {}), set: (o, p, v) => { o[p] = v; return true; } });
}
Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true });
globalThis.window = globalThis;
globalThis.innerWidth = 1280; globalThis.innerHeight = 720; globalThis.devicePixelRatio = 1;
globalThis.matchMedia = () => ({ matches: false });
globalThis.isSecureContext = true;
globalThis.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = v; } };
globalThis.requestAnimationFrame = (fn) => { rafs.push(fn); return rafs.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = (type, fn) => { (listeners[`window:${type}`] ||= []).push(fn); };
globalThis.document = {
  hidden: false,
  getElementById: (id) => (els[id] ||= makeEl(id)),
  querySelector: () => makeEl('q'),
  querySelectorAll: () => [],
  addEventListener(type, fn) { (listeners[`document:${type}`] ||= []).push(fn); },
};

function step(ms) {
  const n = Math.round(ms / 16);
  for (let i = 0; i < n; i++) {
    now += 16;
    const batch = rafs.splice(0);
    batch.forEach((fn) => fn(now));
  }
}
const fire = (key, ev) => (listeners[key] || []).forEach((fn) => fn(ev));
function swipe(x1, y1, x2, y2) {
  fire('stage:pointermove', { clientX: x1, clientY: y1 });
  now += 16;
  fire('stage:pointermove', { clientX: x2, clientY: y2 });
}

await import('../src/main.js');
const g = window.__gfn;

test('landing attract mode runs without errors and without scoring', () => {
  step(3000);
  assert.equal(g.sm.state, 'MENU');
  assert.equal(g.score.score, 0);
});

test('pointer round: countdown -> playing -> slice scores exactly once', () => {
  els.btnPointer.onclick();
  assert.equal(g.sm.state, 'COUNTDOWN');
  step(3500);
  assert.equal(g.sm.state, 'PLAYING');
  g.game.fruits.length = 0; g.game.queue.length = 0; g.game.waveT = 999;
  g.game.fruits.push({ id: 900, type: 'apple', bomb: false, x: 640, y: 300, vx: 0, vy: -1, r: 50, rot: 0, vr: 0, sliced: false, age: 1 });
  swipe(300, 300, 1000, 300); // fast swipe, endpoints far past the fruit
  assert.equal(g.score.score, 2);
  assert.equal(g.score.sliced, 1);
  swipe(1000, 300, 300, 300); // fruit is already sliced
  assert.equal(g.score.score, 2);
});

test('bomb is penalised and never scored as fruit', () => {
  g.score.add(30);
  const before = g.score.score;
  g.game.fruits.push({ id: 901, type: 'apple', bomb: true, x: 640, y: 400, vx: 0, vy: -1, r: 50, rot: 0, vr: 0, sliced: false, age: 1 });
  g.game.waveT = 999;
  swipe(300, 400, 1000, 400);
  assert.equal(g.score.score, before - 15);
  assert.equal(g.game.bombHits, 1);
});

test('pause freezes timer and world; resume continues', () => {
  fire('window:keydown', { key: 'p' });
  assert.equal(g.sm.state, 'PAUSED');
  const t = g.game.elapsed, n = g.game.fruits.length;
  step(2000);
  assert.equal(g.game.elapsed, t);
  assert.equal(g.game.fruits.length, n);
  els.pResume.onclick();
  assert.equal(g.sm.state, 'PLAYING');
});

test('bomb clear: one use, cooldown blocks repeat, no points when nothing to clear', () => {
  g.game.fruits.length = 0; g.game.waveT = 999;
  g.game.fruits.push({ id: 902, type: 'orange', bomb: false, x: 400, y: 300, vx: 0, vy: -1, r: 50, rot: 0, vr: 0, sliced: false, age: 1 });
  const before = g.score.score;
  fire('window:keydown', { key: 'b' });
  assert.equal(g.score.score, before + 5);
  assert.equal(g.bomb.ready, false);
  g.game.fruits.push({ id: 903, type: 'orange', bomb: false, x: 400, y: 300, vx: 0, vy: -1, r: 50, rot: 0, vr: 0, sliced: false, age: 1 });
  fire('window:keydown', { key: 'b' });
  assert.equal(g.score.score, before + 5);
  g.game.fruits.length = 0;
  g.bomb.reset();
  const s2 = g.score.score;
  fire('window:keydown', { key: 'b' });
  assert.equal(g.score.score, s2); // nothing present: harmless, no points
});

test('timer ends the round, saves best, replay resets everything', () => {
  g.game.elapsed = 59.95;
  step(2500);
  assert.equal(g.sm.state, 'GAME_OVER');
  assert.equal(JSON.parse(localStorage._m['gesture-fruit-ninja:v1']).best.time, g.score.score);
  els.oAgain.onclick();
  assert.equal(g.sm.state, 'COUNTDOWN');
  assert.equal(g.score.score, 0);
  assert.equal(g.game.fruits.length, 0);
  assert.equal(g.game.bombHits, 0);
  assert.equal(g.bomb.ready, true);
});

test('long simulated session stays stable', () => {
  step(3500);
  for (let i = 0; i < 20; i++) { step(2000); swipe(100 + i * 10, 200, 1100, 500); }
  assert.ok(['PLAYING', 'GAME_OVER'].includes(g.sm.state));
  assert.ok(g.game.fruits.length < 40);
});
