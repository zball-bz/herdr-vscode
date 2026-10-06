// Usage: node pty-validate.mjs null|xterm|ghostty
// Runs bench/ttybench.sh under a real pty, with a headless emulator acting as "the terminal".
// Validates the DA1-barrier method and gives pty→parser numbers with no IPC and no rendering.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createCoreRuntime } from '@gespenst/core/headless';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const engine = process.argv[2];
const gdir = new URL('./node_modules/@gespenst/core/dist/', import.meta.url);

const p = pty.spawn('bash', [new URL('./ttybench.sh', import.meta.url).pathname, engine], {
  cols: 120, rows: 40, encoding: engine === 'ghostty' ? null : 'utf8',
  env: { ...process.env, XDG_CACHE_HOME: new URL('./cache', import.meta.url).pathname, SIZE_MB: process.env.SIZE_MB || '16', RUNS: '5' },
});
let feed;
if (engine === 'null') {            // answers DA1 without emulating anything: pty + bash + cat ceiling
  let tail = '';
  feed = (d) => { const s = tail + d; let i = -1; while ((i = s.indexOf('\x1b[c', i + 1)) !== -1) p.write('\x1b[?1;2c'); tail = s.slice(-2); };
} else if (engine === 'xterm') {
  const t = new Terminal({ cols: 120, rows: 40, scrollback: 1000, allowProposedApi: true });
  t.onData((d) => p.write(d));
  feed = (d) => t.write(d);
} else if (engine === 'ghostty') {
  const rt = await createCoreRuntime({ wasm: readFileSync(new URL('ghostty-vt.wasm', gdir)), callbacksWasm: readFileSync(new URL('ghostty-callbacks.wasm', gdir)) });
  const t = rt.createTerminal({ cols: 120, rows: 40, scrollbackLines: 1000 });
  t.on('input', (e) => p.write(Buffer.from(e.data)));
  feed = (d) => t.write(d);
}
p.onData((d) => feed(d));
p.onExit(() => { console.log(readFileSync(new URL(`./cache/ttybench/last-${engine}.txt`, import.meta.url), 'utf8')); process.exit(0); });
