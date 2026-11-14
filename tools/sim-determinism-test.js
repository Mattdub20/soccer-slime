// Determinism test for the match simulation used by online rollback play.
// Run:  node tools/sim-determinism-test.js
// It pulls simStep and its constants out of index.html, then checks that:
//  1. two copies fed the same inputs stay bit-for-bit identical for thousands of frames,
//  2. snapshot + restore + re-simulate gives exactly the same result (what a rollback does),
//  3. a rollback client that guesses the other player's input and corrects late ends up identical.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function grab(re, what) { const m = html.match(re); if (!m) throw new Error('could not find ' + what); return m[0]; }
const src = [
  grab(/^var GW=.*$/m, 'GW'), grab(/^var TS=.*$/m, 'TS'), grab(/^var GRAV=.*$/m, 'GRAV'),
  grab(/^var SPIN_F=.*$/m, 'SPIN_F'), grab(/^var CEILING_Y=.*$/m, 'CEILING_Y'), grab(/^var SF=.*$/m, 'SF'),
  grab(/^function mkSlime\(x\).*$/m, 'mkSlime'), grab(/\/\/ ==SIM BEGIN==[\s\S]*?\/\/ ==SIM END==/, 'SIM block'),
].join('\n');
const ctx = {}; vm.createContext(ctx); vm.runInContext(src + '\nthis.api={simStep,simClone,simHash,simIn,mkSlime,GW,GH,GRND,BR};', ctx);
const A = ctx.api;
const CFG = { pract: false, unlimJump: false, unlim: false, over: false, win: null, solo: null };
let fails = 0;
function check(ok, msg) { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; }

// Small seeded RNG so every run uses the same "players".
function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
// A player that holds directions for a while, taps jump, and holds/releases dash, like a person mashing keys.
function player(seed) {
  const r = rng(seed); let dir = 0, hold = 0, dash = false, out = [];
  return () => {
    if (--hold <= 0) { dir = Math.floor(r() * 3); hold = 5 + Math.floor(r() * 40); }
    let b = dir === 1 ? 1 : dir === 2 ? 2 : 0;
    if (r() < 0.04) b |= 4;
    const nd = dash ? r() > 0.08 : r() < 0.03; if (nd) b |= 8; if (dash && !nd) b |= 16; dash = nd;
    return b;
  };
}
function start() { return { left: A.mkSlime(200), right: A.mkSlime(600), ball: { x: A.GW / 2, y: 150, vx: 0, vy: 0 }, _sonic: null, frz: 30 }; }
// Keep the ball in play: put it back in the middle after a goal (the real game does this outside the sim too).
function step(s, l, r, ev) {
  let goal = null; A.simStep(s, A.simIn(l), A.simIn(r), CFG, { goal: (side) => { goal = goal || side; }, kick: () => ev && ev.k++ });
  if (goal) { ev && ev.g++; Object.assign(s.left, A.mkSlime(200)); Object.assign(s.right, A.mkSlime(600)); s.ball = { x: A.GW / 2, y: 150, vx: 0, vy: 0 }; s.frz = 30; }
}
const N = 5000;
const pl = player(1), pr = player(2), IL = [], IR = [];
for (let i = 0; i < N; i++) { IL.push(pl()); IR.push(pr()); }

// 1. two copies, same inputs
{
  const a = start(), b = start(), ev = { k: 0, g: 0 }; let same = true, at = -1;
  for (let i = 0; i < N; i++) { step(a, IL[i], IR[i], ev); step(b, IL[i], IR[i]); if (A.simHash(a) !== A.simHash(b)) { same = false; at = i; break; } }
  check(same, `two copies match for ${N} frames (${ev.k} ball touches, ${ev.g} goals)` + (same ? '' : ' - first difference at frame ' + at));
  check(ev.k > 20 && ev.g > 5, 'the test actually exercises play (enough ball touches)');
}
// 2. snapshot / restore / re-simulate
{
  const a = start(), hashes = [], snaps = [];
  for (let i = 0; i < N; i++) { snaps.push(A.simClone(a)); step(a, IL[i], IR[i]); hashes.push(A.simHash(a)); }
  let ok = true;
  for (let t = 0; t < 50; t++) {
    const from = 100 + t * 97, s = A.simClone(snaps[from]);
    for (let i = from; i < from + 12; i++) { step(s, IL[i], IR[i]); if (A.simHash(s) !== hashes[i]) { ok = false; break; } }
  }
  check(ok, 'restore a saved state and re-run 12 frames gives the same result (50 spots)');
  const before = A.simHash(snaps[500]); const live = A.simClone(snaps[500]); for (let i = 0; i < 30; i++) step(live, IL[500 + i], IR[500 + i]);
  check(A.simHash(snaps[500]) === before, 'saved states are independent copies');
}
// 3. rollback client: predicts the right player's input (repeat held keys), learns the truth LAG frames late.
{
  const LAG = 5, RING = 64, truth = start(), cl = start(), st = [], pred = [];
  let conf = -1, rbs = 0, ok = true;
  for (let f = 0; f < N; f++) {
    step(truth, IL[f], IR[f]);
    // the real input for frame f-LAG arrives now
    const nc = f - LAG; if (nc >= 0) {
      conf = nc;
      if (pred[nc] !== IR[nc]) { // wrong guess: rewind and replay
        rbs++; const c = A.simClone(st[nc % RING]); Object.assign(cl, c); cl.left = c.left; cl.right = c.right; cl.ball = c.ball;
        for (let k = nc; k < f; k++) { st[k % RING] = A.simClone(cl); const g = k <= conf ? IR[k] : (IR[conf] & 11); pred[k] = g; step(cl, IL[k], g); }
      }
    }
    st[f % RING] = A.simClone(cl); const g = f <= conf ? IR[f] : (conf >= 0 ? IR[conf] & 11 : 0); pred[f] = g; step(cl, IL[f], g);
  }
  // finish: everything is confirmed now, replay the tail with real inputs
  const tailFrom = N - LAG; const c = A.simClone(st[tailFrom % RING]); for (let k = tailFrom; k < N; k++) step(c, IL[k], IR[k]);
  check(A.simHash(c) === A.simHash(truth), `rollback client ends identical to the real match (${rbs} rewinds over ${N} frames)`);
}
console.log(fails ? `\n${fails} check(s) failed` : '\nAll determinism checks passed.');
process.exit(fails ? 1 : 0);
