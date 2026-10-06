// Usage: node headless-parse.mjs
// Headless VT parse+state throughput: @xterm/headless (VS Code's exact version) vs Ghostty WASM (@gespenst/core).
// No rendering, no IPC — this isolates only the emulator core that a "swap" would replace.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createCoreRuntime } from '@gespenst/core/headless';

const require = createRequire(import.meta.url);
const { Terminal: XtermHeadless } = require('@xterm/headless');
const gdir = new URL('./node_modules/@gespenst/core/dist/', import.meta.url);

const COLS = 120, ROWS = 40, SCROLLBACK = 1000; // VS Code default scrollback = 1000
const TARGET = 32 * 1024 * 1024;                  // ~32 MB per corpus
const CHUNK = 64 * 1024;                          // node-pty / IPC sized chunks
const RUNS = 5;

// Deterministic PRNG so both engines see identical bytes.
let seed = 42;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const words = 'const let return function import export async await if else for while class new this'.split(' ');
const cjk = '终端性能测试渲染解析吞吐延迟字符宽度表情符号';
const emoji = ['😀', '🚀', '👍🏽', '🇨🇳', '👨‍👩‍👧'];

function build(kind) {
  seed = 42;
  const parts = [];
  let size = 0;
  while (size < TARGET) {
    let line = '';
    if (kind === 'ascii') {
      while (line.length < 60 + rnd(50)) line += words[rnd(words.length)] + ' ';
      line += '\r\n';
    } else if (kind === 'sgr') {        // rg/ls --color / compiler diagnostics style
      for (let i = 0; i < 10; i++) {
        line += `\x1b[38;2;${rnd(256)};${rnd(256)};${rnd(256)}m${words[rnd(words.length)]}\x1b[0m `;
        if (rnd(4) === 0) line += `\x1b[1;4;48;5;${rnd(256)}m!\x1b[0m`;
      }
      line += '\r\n';
    } else if (kind === 'tui') {        // full-screen app redraws (vim/htop/agent TUIs)
      for (let i = 0; i < 8; i++) {
        line += `\x1b[${1 + rnd(ROWS)};${1 + rnd(COLS - 20)}H\x1b[3${rnd(8)};4${rnd(8)}m${words[rnd(words.length)]}\x1b[K`;
      }
      line += '\x1b[0m';
    } else if (kind === 'unicode') {    // wide CJK + emoji/grapheme clusters
      for (let i = 0; i < 25; i++) line += rnd(5) === 0 ? emoji[rnd(emoji.length)] : cjk[rnd(cjk.length)];
      line += '\r\n';
    }
    parts.push(line);
    size += Buffer.byteLength(line);
  }
  const str = parts.join('');
  const bytes = new TextEncoder().encode(str);
  const strChunks = [], byteChunks = [];
  for (let i = 0; i < str.length; i += CHUNK) strChunks.push(str.slice(i, i + CHUNK));
  for (let i = 0; i < bytes.length; i += CHUNK) byteChunks.push(bytes.subarray(i, i + CHUNK));
  return { bytes: bytes.length, strChunks, byteChunks };
}

async function xtermRun(c) {
  const t = new XtermHeadless({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
  const t0 = performance.now();
  await new Promise((res) => {
    for (let i = 0; i < c.strChunks.length - 1; i++) t.write(c.strChunks[i]);
    t.write(c.strChunks.at(-1), res);
  });
  const ms = performance.now() - t0;
  const last = t.buffer.active.getLine(t.buffer.active.baseY + ROWS - 2)?.translateToString(true).trimEnd();
  t.dispose();
  return { ms, last };
}

function xtermSyncRun(c) {
  const t = new XtermHeadless({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
  const t0 = performance.now();
  for (const ch of c.strChunks) t._core._writeBuffer.writeSync(ch);
  const ms = performance.now() - t0;
  t.dispose();
  return { ms };
}

function ghosttyRun(rt, chunks) {
  const t = rt.createTerminal({ cols: COLS, rows: ROWS, scrollbackLines: SCROLLBACK });
  const t0 = performance.now();
  for (const ch of chunks) t.write(ch);
  const ms = performance.now() - t0;
  const last = t.viewport().viewportRows[ROWS - 2]?.text?.trimEnd();
  t.dispose();
  return { ms, last };
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

const rt = await createCoreRuntime({
  wasm: readFileSync(new URL('ghostty-vt.wasm', gdir)),
  callbacksWasm: readFileSync(new URL('ghostty-callbacks.wasm', gdir)),
});

console.log(`node ${process.version}  grid ${COLS}x${ROWS}  scrollback ${SCROLLBACK}  chunk ${CHUNK / 1024}KB  runs ${RUNS} (median)\n`);
console.log('corpus    MB   xterm.js   xterm.js(sync)   ghostty(bytes)   ghostty(string)   last-row match   [MB/s]');
for (const kind of ['ascii', 'sgr', 'tui', 'unicode']) {
  const c = build(kind);
  const mb = c.bytes / 1e6;
  const res = { x: [], xs: [], gb: [], gs: [] };
  let lx, lg;
  for (let r = 0; r <= RUNS; r++) {           // run 0 is warm-up
    const x = await xtermRun(c);
    const xs = xtermSyncRun(c);
    const gb = ghosttyRun(rt, c.byteChunks);
    const gs = ghosttyRun(rt, c.strChunks);
    if (r === 0) { lx = x.last; lg = gb.last; continue; }
    res.x.push(x.ms); res.xs.push(xs.ms); res.gb.push(gb.ms); res.gs.push(gs.ms);
  }
  const f = (ms) => (mb / (median(ms) / 1000)).toFixed(0).padStart(6);
  console.log(`${kind.padEnd(8)} ${mb.toFixed(0).padStart(3)}   ${f(res.x)}     ${f(res.xs)}           ${f(res.gb)}           ${f(res.gs)}            ${lx === lg ? 'yes' : 'NO'}`);
  if (lx !== lg) console.log(`   xterm:   ${JSON.stringify(lx)}\n   ghostty: ${JSON.stringify(lg)}`);
}

// Per-call CPU cost of tiny writes (shell echo / prompt redraw sized), not end-to-end latency.
{
  const N = 200_000, msg = '\x1b[32mx\x1b[0m\x1b[K';
  const xt = new XtermHeadless({ cols: COLS, rows: ROWS, allowProposedApi: true });
  let t0 = performance.now(); for (let i = 0; i < N; i++) xt._core._writeBuffer.writeSync(msg); const xus = (performance.now() - t0) * 1000 / N;
  const gt = rt.createTerminal({ cols: COLS, rows: ROWS });
  const mb = new TextEncoder().encode(msg);
  t0 = performance.now(); for (let i = 0; i < N; i++) gt.write(mb); const gus = (performance.now() - t0) * 1000 / N;
  console.log(`\ntiny write (${mb.length}B) per-call: xterm.js ${xus.toFixed(2)} us   ghostty ${gus.toFixed(2)} us`);
}
rt.dispose();
