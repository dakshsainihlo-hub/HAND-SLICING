# Gesture Fruit Ninja

Your index finger is the blade. Point and swipe to slice fruit, make a fist for a bomb-clear shockwave, open your palm to pause. Webcam hand tracking runs in your browser.

## Stack

- Vanilla JavaScript (ES modules), **no build step**, no backend, no API keys
- HTML5 Canvas for rendering, CSS for menus and HUD, Web Audio for procedural sound
- MediaPipe Tasks Vision `HandLandmarker`, runtime pinned to `@mediapipe/tasks-vision@0.10.14`
- `node:test` for tests

I chose no-build over React/Vite so the whole game is a static folder you can host anywhere and read top to bottom.

## Run it

Prerequisites: Node 18+ (only for the dev server and tests).

```bash
cd gesture-fruit-ninja
npm start          # serves http://localhost:5173
```

Open `http://localhost:5173` in Chrome or Edge. **Don't open `index.html` by double-clicking**: ES modules and the camera need `http://localhost` or HTTPS.

Any static server works (`python3 -m http.server 5173` too).

## Test

```bash
npm test      # 20 logic tests + 7 headless smoke tests
npm run check # syntax check
```

What the tests cover: gesture classification from synthetic landmarks (including rotation), debouncing, fist/palm firing once per hold, bomb cooldown, swept segment-vs-fruit collision, single-hit scoring, combos, timer/round end, reset, storage failures, camera error mapping, stream release, illegal state transitions. The smoke test drives a full round through the mouse/touch fallback against a stubbed DOM.

**Not covered by automated tests:** real webcam input, MediaPipe model loading, real rendering quality, audio output, and layout on real devices. Verify those by hand (below).

## Try the gestures

1. Click **PLAY NOW** and allow the camera.
2. In the quick check, point, make a fist, then open your palm. Each box ticks when detected.
3. Play. Keep your hand well lit and your whole hand in frame, palm roughly facing the camera.
   - **Point + swipe**: slices. The blade re-arms after a few stable pointing frames.
   - **Fist** (while playing): one bomb clear, then an 8 second cooldown. Release the fist to use it again later.
   - **Open palm**: pauses. Resume with the **Resume** button (or `Esc` / `P`). Gestures never resume the game.

Keyboard/mouse extras: `Esc`/`P` pause, `B` bomb clear.

## Camera troubleshooting

- Webcams only work on **HTTPS or localhost**.
- Blocked permission: click the camera icon in the address bar, allow, then **Retry camera**.
- "In use by another app": close Zoom/Teams/etc., retry.
- No camera: use **Play with mouse or touch** (a labelled fallback, not the main mode).

## Hand model setup

By default the game loads the model from Google's official bucket:
`https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`

For offline or self-hosted use, download that file to `models/hand_landmarker.task`. The game tries `./models/` first, then the bucket. The WASM runtime comes from jsDelivr; to self-host it, copy `node_modules/@mediapipe/tasks-vision/wasm` into the project and change `MP_BASE` in `src/main.js`.

## Privacy

- Video frames are processed locally by MediaPipe in your browser. They are never uploaded, stored, or saved.
- The page does download the model and runtime from a CDN, and fonts from Google Fonts. That is code and assets coming in, not your data going out.
- `localStorage` (key `gesture-fruit-ninja:v1`) holds only best scores, sound preferences, and whether you've done the quick check.
- No analytics, accounts, or tracking.

## Deploy

It is a static folder. Everything uses relative paths (`./src`, `./models`), so it works under a project subpath.

- **GitHub Pages**: push, then Settings > Pages > deploy from branch, root folder. Pages serves HTTPS, so the camera works.
- **Netlify / Vercel / Cloudflare Pages**: publish the folder as-is, no build command.

I have not deployed it; there is no live URL.

## Rules (see `src/logic.js`)

| | |
|---|---|
| Time Attack | 60 s, bombs on, waves speed up |
| Zen | 120 s, slower fruit, no bombs |
| Endless | no clock, 3 bomb hits end the run |
| Points | pineapple 5, strawberry 4, watermelon/lemon/peach 3, orange/apple 2, coconut 6 |
| Combo | slices within 1 s chain; multiplier +1 every 5 combo, max x4; 3+ fruit in one swipe adds a bonus |
| Bomb | -15 points, breaks combo |
| Bomb clear | 5 points per cleared fruit, 8 s cooldown, no charge spent if nothing is on screen |
| Misses | never penalised |

## Architecture

```
index.html        markup, design system, overlays
src/logic.js      pure logic: gesture classifier, debouncer, coordinate mapping,
                  smoothing, collision, scoring, bomb charge, state machine, storage
src/main.js       camera + MediaPipe loop, engine, renderer, particles, audio, UI wiring
test/             unit tests + headless smoke test
```

Hand tracking runs one throttled (30 fps) inference loop on the main thread, decoupled from the render loop. A Web Worker was not used.

## Known limitations

- Not verified with a real webcam in the environment this was built in. Gesture thresholds (`CONFIG.gesture`) are reasoned from landmark geometry and unit-tested on synthetic hands; expect to tune them against real hands and lighting.
- Gestures measure finger extension in 2D, so a hand pointed straight at the camera (heavy foreshortening) can misclassify.
- Hand-to-screen mapping stretches the camera frame to the screen; there is no aspect-ratio correction.
- Inference is on the main thread; low-end machines may see lower tracking rates. Rendering drops particle effects automatically if frames get slow.
- Browser support was not tested. Chrome/Edge are the intended targets; Safari and mobile may work but are unverified.
- Palm-to-resume gesture is intentionally not implemented; resume is button/keyboard only.
