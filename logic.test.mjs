import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG, classifyHand, GestureStabilizer, mapToArena, PointSmoother, segmentHitsCircle,
  ScoreManager, BombCharge, StateMachine, loadSave, writeSave, SAVE_KEY, classifyCameraError, releaseStream,
} from '../src/logic.js';

// Build 21 synthetic landmarks. Wrist at (0.5, 0.8); knuckles 0.2 above; fingers either extended or curled.
function hand({ index = 'ext', middle = 'ext', ring = 'ext', pinky = 'ext', spread = true, rot = 0 } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.8, z: 0 }));
  const xs = [0.4, 0.47, 0.54, 0.61];
  const states = [index, middle, ring, pinky];
  const knuckles = [5, 9, 13, 17];
  const tips = [8, 12, 16, 20];
  states.forEach((s, i) => {
    const kx = xs[i], ky = 0.6;
    lm[knuckles[i]] = { x: kx, y: ky, z: 0 };
    lm[knuckles[i] + 1] = { x: kx, y: s === 'ext' ? 0.5 : 0.62, z: 0 };
    lm[knuckles[i] + 2] = { x: kx, y: s === 'ext' ? 0.42 : 0.68, z: 0 };
    const tipX = s === 'ext' && spread ? kx + (i - 1.5) * 0.07 : kx;
    lm[tips[i]] = { x: tipX, y: s === 'ext' ? 0.33 : 0.7, z: 0 };
  });
  if (!rot) return lm;
  const c = Math.cos(rot), s = Math.sin(rot);
  return lm.map((p) => ({ x: 0.5 + (p.x - 0.5) * c - (p.y - 0.5) * s, y: 0.5 + (p.x - 0.5) * s + (p.y - 0.5) * c, z: 0 }));
}
const fold = 'fold';

test('classifies pointing, fist, open palm', () => {
  assert.equal(classifyHand(hand({ middle: fold, ring: fold, pinky: fold })).gesture, 'INDEX_POINTING');
  assert.equal(classifyHand(hand({ index: fold, middle: fold, ring: fold, pinky: fold })).gesture, 'FIST');
  assert.equal(classifyHand(hand()).gesture, 'OPEN_PALM');
});

test('closed-together straight fingers are not an open palm', () => {
  assert.equal(classifyHand(hand({ spread: false })).gesture, 'OTHER_GESTURE');
});

test('classification is rotation tolerant', () => {
  for (const rot of [0.5, -0.6, 1.2, 3.0]) {
    assert.equal(classifyHand(hand({ middle: fold, ring: fold, pinky: fold }), CONFIG.gesture, rot).gesture, 'INDEX_POINTING');
    assert.equal(classifyHand(hand({ middle: fold, ring: fold, pinky: fold, rot })).gesture, 'INDEX_POINTING');
    assert.equal(classifyHand(hand({ index: fold, middle: fold, ring: fold, pinky: fold, rot })).gesture, 'FIST');
  }
});

test('missing hand is NO_HAND, never fist or palm', () => {
  assert.equal(classifyHand(null).gesture, 'NO_HAND');
  assert.equal(classifyHand([]).gesture, 'NO_HAND');
});

test('single misclassified frame does not confirm a fist', () => {
  const s = new GestureStabilizer();
  for (let i = 0; i < 5; i++) s.update('INDEX_POINTING');
  assert.equal(s.update('FIST').entered, null);
  assert.equal(s.update('INDEX_POINTING').entered, null);
  assert.equal(s.stable, 'INDEX_POINTING');
});

test('holding a fist fires exactly one entry event', () => {
  const s = new GestureStabilizer();
  let entries = 0;
  for (let i = 0; i < 120; i++) if (s.update('FIST').entered === 'FIST') entries++;
  assert.equal(entries, 1);
  s.update('INDEX_POINTING'); s.update('INDEX_POINTING');
  for (let i = 0; i < 10; i++) if (s.update('FIST').entered === 'FIST') entries++;
  assert.equal(entries, 2); // released, then re-entered
});

test('holding an open palm fires one pause event, not a toggle storm', () => {
  const s = new GestureStabilizer();
  let entries = 0;
  for (let i = 0; i < 200; i++) if (s.update('OPEN_PALM').entered === 'OPEN_PALM') entries++;
  assert.equal(entries, 1);
});

test('losing the hand does not become fist or palm', () => {
  const s = new GestureStabilizer();
  for (let i = 0; i < 10; i++) s.update('INDEX_POINTING');
  const seen = [];
  for (let i = 0; i < 10; i++) seen.push(s.update('NO_HAND').entered);
  assert.deepEqual(seen.filter(Boolean), ['NO_HAND']);
});

test('bomb charge: cooldown blocks repeat use and is driven by game time', () => {
  const b = new BombCharge(8);
  assert.equal(b.tryUse(), true);
  assert.equal(b.tryUse(), false);
  b.update(7.9);
  assert.equal(b.tryUse(), false);
  b.update(0.2);
  assert.equal(b.tryUse(), true);
});

test('segment hits circle, including a fast swipe that skips over the centre', () => {
  assert.equal(segmentHitsCircle(0, 0, 100, 0, 50, 5, 10), true);
  // endpoints are far on either side of the fruit: a point-only test would miss it
  assert.equal(segmentHitsCircle(0, 100, 400, 100, 200, 110, 30), true);
  assert.equal(segmentHitsCircle(0, 100, 400, 100, 200, 160, 30), false);
  assert.equal(segmentHitsCircle(10, 10, 10, 10, 10, 10, 5), true); // zero-length segment
});

test('mapToArena mirrors and clamps', () => {
  const left = mapToArena({ x: 0.9, y: 0.5 }, 1000, 500); // camera right = player left
  assert.ok(left.x < 500);
  const edge = mapToArena({ x: 0, y: 0 }, 1000, 500);
  assert.deepEqual(edge, { x: 1000, y: 0 });
  const mid = mapToArena({ x: 0.5, y: 0.5 }, 1000, 500);
  assert.ok(Math.abs(mid.x - 500) < 1e-9 && Math.abs(mid.y - 250) < 1e-9);
});

test('smoother rejects implausible jumps and damps jitter', () => {
  const sm = new PointSmoother();
  sm.update({ x: 100, y: 100 }, 0, 1000, 600);
  const jitter = sm.update({ x: 104, y: 100 }, 33, 1000, 600);
  assert.ok(jitter.x < 104 && jitter.x > 100 && !jitter.jumped);
  const jump = sm.update({ x: 950, y: 580 }, 66, 1000, 600);
  assert.equal(jump.jumped, true);
  assert.equal(jump.x, 950);
});

test('score: each slice scores once, combos build and expire, swipes bonus', () => {
  const s = new ScoreManager();
  let r = s.slice(2, 0, 1);
  assert.equal(r.pts, 2); assert.equal(s.score, 2);
  for (let i = 1; i < 5; i++) s.slice(2, i * 0.3, 1);
  assert.equal(s.combo, 5);
  r = s.slice(2, 1.6, 1);
  assert.equal(r.mult, 2);
  assert.ok(r.swipeBonus > 0); // 3+ in one swipe
  s.expire(10);
  assert.equal(s.combo, 0);
  const before = s.score;
  s.slice(3, 10, 2);
  assert.equal(s.score, before + 3);
  assert.equal(s.sliced, 7);
});

test('bomb penalty never drops score below zero', () => {
  const s = new ScoreManager();
  s.add(5); s.penalty(15);
  assert.equal(s.score, 0);
});

test('reset returns score state to zero', () => {
  const s = new ScoreManager();
  s.slice(5, 0, 1); s.reset();
  assert.equal(s.score, 0); assert.equal(s.combo, 0); assert.equal(s.sliced, 0);
});

test('state machine blocks illegal transitions', () => {
  const log = [];
  const sm = new StateMachine('MENU', (n, p) => log.push(`${p}>${n}`));
  assert.equal(sm.go('PLAYING'), false);
  assert.equal(sm.go('PAUSED'), false);
  assert.equal(sm.go('SETUP'), true);
  assert.equal(sm.go('CALIBRATING'), true);
  assert.equal(sm.go('COUNTDOWN'), true);
  assert.equal(sm.go('PLAYING'), true);
  assert.equal(sm.go('PAUSED'), true);
  assert.equal(sm.go('GAME_OVER'), true);
  assert.equal(sm.go('PLAYING'), false);
  assert.equal(sm.state, 'GAME_OVER');
  assert.equal(log.length, 6);
});

test('storage: failures never throw and defaults are returned', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.equal(loadSave(broken).best.time, 0);
  assert.equal(writeSave(broken, {}), false);
  assert.equal(loadSave(null).sound, true);
  const junk = { getItem: () => '{not json' };
  assert.equal(loadSave(junk).best.zen, 0);
});

test('storage: round-trips and sanitises values', () => {
  const mem = {};
  const st = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } };
  assert.equal(writeSave(st, { best: { time: 42, zen: 'x', endless: -9 }, volume: 5, sound: false }), true);
  const s = loadSave(st);
  assert.equal(s.best.time, 42);
  assert.equal(s.best.zen, 0);
  assert.equal(s.best.endless, 0);
  assert.equal(s.volume, 1);
  assert.equal(s.sound, false);
  assert.ok(SAVE_KEY.includes(':v1'));
});

test('camera failures map to recoverable messages', () => {
  assert.equal(classifyCameraError({ name: 'NotAllowedError' }).code, 'denied');
  assert.equal(classifyCameraError({ name: 'NotFoundError' }).code, 'missing');
  assert.equal(classifyCameraError({ name: 'NotReadableError' }).code, 'busy');
  assert.equal(classifyCameraError({ code: 'model' }).code, 'model');
  assert.equal(classifyCameraError(new Error('x')).code, 'unknown');
  assert.match(classifyCameraError({ name: 'NotAllowedError' }).message, /HTTPS or localhost/);
});

test('releaseStream stops every track', () => {
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => stopped++ }, { stop: () => stopped++ }] };
  assert.equal(releaseStream(stream), 2);
  assert.equal(stopped, 2);
  assert.equal(releaseStream(null), 0);
});
