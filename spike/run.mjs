// Spike: drive herdr's gen1 client-shell endpoint with the WASM core over a local unix socket.
// Usage: node run.mjs <client-socket-path>
// Phases: handshake + first surface → bulk output (seq) → per-keystroke latency → capture replay bench.
import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Core } = require('./herdr-core/pkg/herdr_core.js');
const SOCKET = process.argv[2];
const COLS = 120, ROWS = 40;

const core = new Core();
const sock = net.connect(SOCKET);
const capture = [];                       // raw inbound chunks, for offline replay
const waiters = [];                       // resolve on the next event matching a predicate
let lastSurfaceAt = 0;
const counts = {};

sock.on('data', (chunk) => {
  const at = performance.now();
  capture.push(Buffer.from(chunk));
  const events = JSON.parse(core.feed(chunk));
  for (const e of events) {
    const key = e.type === 'surface' ? `surface:${e.via}` : e.type === 'message' ? `message:${e.kind}` : e.type;
    counts[key] = (counts[key] || 0) + 1;
    if (e.type === 'surface') lastSurfaceAt = at;
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].match(e)) waiters.splice(i, 1)[0].resolve({ e, at });
  }
});
sock.on('error', (err) => { console.error('socket error', err.message); process.exit(1); });

const next = (match, ms = 5000) => new Promise((resolve, reject) => {
  const w = { match, resolve };
  waiters.push(w);
  setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout')); } }, ms);
});
const send = (bytes) => sock.write(bytes);
const quiet = async (ms) => { while (performance.now() - lastSurfaceAt < ms) await new Promise((r) => setTimeout(r, 50)); };
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];

// 1. handshake
const welcomeP = next((e) => e.type === 'welcome');
const surfaceP = next((e) => e.type === 'surface' && e.via === 'full');
const t0 = performance.now();
send(core.hello(COLS, ROWS, 9, 18, true));
const { e: welcome } = await welcomeP;
const { at: firstSurfaceAt, e: first } = await surfaceP;
console.log(`welcome: herdr ${welcome.server_version}, ${welcome.methods} methods, capabilities: ${welcome.capabilities.join(', ')}`);
console.log(`first full surface ${first.width}x${first.height}, ${first.panes} pane(s), ${(firstSurfaceAt - t0).toFixed(1)} ms after hello`);
const pane = core.focused_pane_id();
console.log('focused pane:', pane, ' panes:', core.panes_json());
await quiet(500);

// 2. bulk output through the shell: seq 1 200000
let before = { ...counts }, bytes0 = core.bytes(), msgs0 = core.messages();
const tBulk = performance.now();
send(core.input_text(pane, 'seq 1 200000'));
send(core.input_enter(pane));
await next((e) => e.type === 'surface', 5000);
await quiet(1000);
const bulkMs = lastSurfaceAt - tBulk;
const delta = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v - (before[k] || 0)]).filter(([, v]) => v));
console.log(`\nbulk 'seq 1 200000': ${bulkMs.toFixed(0)} ms until last surface update, ${core.messages() - msgs0} messages, ${((core.bytes() - bytes0) / 1024).toFixed(0)} KB received`);
console.log('  updates by kind:', JSON.stringify(delta));
const tail = core.text().split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-3);
console.log('  last visible rows:', JSON.stringify(tail));

// 2b. full-screen redraw stress: ttyanim.py inside the pane (DA1 is answered by herdr's server-side libghostty-vt)
before = { ...counts }; bytes0 = core.bytes(); msgs0 = core.messages();
const tAnim = performance.now();
send(core.input_text(pane, 'clear; SECONDS_PER_TEST=2 python3 ' + new URL('../bench/ttyanim.py', import.meta.url).pathname + ' herdr'));
send(core.input_enter(pane));
await next((e) => e.type === 'surface', 5000);
await quiet(1500);
const animS = (lastSurfaceAt - tAnim) / 1000;
const animMsgs = core.messages() - msgs0, animKB = (core.bytes() - bytes0) / 1024;
console.log(`\nttyanim (4 workloads x 2 s): ${animS.toFixed(1)} s, ${animMsgs} messages (${(animMsgs / animS).toFixed(0)}/s), ${animKB.toFixed(0)} KB (${(animKB / animS).toFixed(0)} KB/s, ${(animKB * 1024 / animMsgs).toFixed(0)} B/message)`);
console.log('  updates by kind:', JSON.stringify(Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v - (before[k] || 0)]).filter(([, v]) => v))));
console.log('  pane output:', JSON.stringify(core.text().split('\n').map((l) => l.trimEnd()).filter((l) => /fps|ttyanim/.test(l))));

// 3. keystroke → surface latency (shell echo through herdr's server, libghostty-vt, diff, encode)
send(core.input_text(pane, '# '));
await next((e) => e.type === 'surface');
await quiet(200);
const lat = [];
for (let i = 0; i < 60; i++) {
  const p = next((e) => e.type === 'surface', 2000);
  const ts = performance.now();
  send(core.input_text(pane, 'x'));
  const { at } = await p;
  lat.push(at - ts);
  await new Promise((r) => setTimeout(r, 30));
}
send(core.input_enter(pane));
console.log(`\nkeystroke → patch (localhost, ${lat.length} keys): p50 ${pct(lat, 0.5).toFixed(2)} ms  p95 ${pct(lat, 0.95).toFixed(2)} ms  max ${Math.max(...lat).toFixed(2)} ms`);
await quiet(500);

// 4. replay the captured byte stream through fresh cores
sock.end();
const total = capture.reduce((n, c) => n + c.length, 0);
writeFileSync(new URL('./capture.bin', import.meta.url), Buffer.concat(capture.map((c) => { const h = Buffer.alloc(4); h.writeUInt32LE(c.length); return Buffer.concat([h, c]); })));
const runs = [];
let exportMs = 0, exports = 0, cellWords = 0;
for (let r = 0; r < 20; r++) {
  const c = new Core();
  const s = performance.now();
  for (const chunk of capture) {
    const events = JSON.parse(c.feed(chunk));
    if (r === 0 && events.some((e) => e.type === 'surface')) {
      const es = performance.now();
      cellWords = c.export_cells().length;
      exportMs += performance.now() - es; exports++;
    }
  }
  if (r > 0) runs.push(performance.now() - s);
  c.free();
}
const med = pct(runs, 0.5);
console.log(`\nreplay: ${capture.length} chunks, ${(total / 1024).toFixed(0)} KB, ${core.messages()} messages`);
console.log(`  decode+apply: ${med.toFixed(1)} ms per replay (${(total / 1e6 / (med / 1000)).toFixed(0)} MB/s, ${(med * 1000 / core.messages()).toFixed(1)} us/message)`);
console.log(`  export_cells: ${(exportMs * 1000 / exports).toFixed(0)} us avg over ${exports} exports (${cellWords / 4} cells each, dirty rows only after the first)`);
process.exit(0);
