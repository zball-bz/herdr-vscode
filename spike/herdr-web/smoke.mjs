// End-to-end check of herdr-web in Chrome (real GPU) against an isolated herdr session.
// Usage: node smoke.mjs <herdr-client.sock>
// Phases: load + first paint → typed command → keystroke-to-paint latency → full-screen redraw stress.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../bench/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const ROOT = new URL('.', import.meta.url).pathname;
const SOCKET = process.argv[2];
const ANIM = new URL('../../bench/ttyanim.py', import.meta.url).pathname;

const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), SOCKET], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const logs = [];
page.on('console', (m) => { if (m.type() !== 'debug') logs.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  window.addEventListener('keydown', () => { window.__keyAt = performance.now(); }, true);
});

const t0 = Date.now();
await page.goto(url);
await page.waitForFunction(() => window.__herdrPaints > 0 && window.__herdrPaintedRevision > 0, null, { timeout: 30000 });
const init = await page.evaluate(() => ({ initMs: window.__initMs, paints: window.__herdrPaints }));
console.log(`first painted surface ${Date.now() - t0} ms after navigation (wasm init ${init.initMs?.toFixed(0)} ms)`);
await page.mouse.click(600, 400);
await page.keyboard.type('printf "\\e[1;35mhello from herdr-web\\e[0m %s\\n" "界面 🚀"; ls --color=always / | head -8');
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
await page.screenshot({ path: join(ROOT, 'shot-command.png') });

// keystroke → painted revision (in-page clocks: keydown capture vs. paint timestamp)
const lat = [];
for (let i = 0; i < 40; i++) {
  const before = await page.evaluate(() => window.__herdrPaintedRevision);
  await page.keyboard.press('x');
  await page.waitForFunction((r) => window.__herdrPaintedRevision > r, before, { timeout: 3000 });
  lat.push(await page.evaluate(() => window.__herdrPaintAt - window.__keyAt));
  await page.waitForTimeout(40);
}
await page.keyboard.press('Control+U');
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
console.log(`keystroke → paint (localhost, 40 keys): p50 ${pct(lat, 0.5).toFixed(1)} ms  p95 ${pct(lat, 0.95).toFixed(1)} ms  max ${Math.max(...lat).toFixed(1)} ms`);

// full-screen redraw stress: client paints/s and CPU while ttyanim runs in the pane
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const cpu = () => {
  let total = 0;
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes('--type=renderer') && !cmd.includes('--type=gpu-process')) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      total += (Number(f[11]) + Number(f[12])) * 10;
    } catch {}
  }
  return total;
};
await page.keyboard.type(`clear; SECONDS_PER_TEST=2 python3 ${ANIM} herdr-web`);
const m0 = await metric(), c0 = cpu(), p0 = await page.evaluate(() => window.__herdrPaints), s0 = Date.now();
await page.keyboard.press('Enter');
await page.waitForTimeout(9500);
const m1 = await metric(), c1 = cpu(), p1 = await page.evaluate(() => window.__herdrPaints), secs = (Date.now() - s0) / 1000;
console.log(`stress (ttyanim 4 x 2 s): ${((p1 - p0) / secs).toFixed(1)} paints/s, main thread ${(((m1.TaskDuration - m0.TaskDuration) * 1000) / (p1 - p0)).toFixed(2)} ms/paint, renderer+gpu CPU ${((c1 - c0) / secs / 10).toFixed(0)}% of a core`);
await page.screenshot({ path: join(ROOT, 'shot-stress.png') });
if (logs.length) console.log('page log:\n  ' + logs.slice(0, 12).join('\n  '));
await browser.close();
server.kill();
