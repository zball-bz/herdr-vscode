// Keystroke → painted revision for a text key ('x', input-handler path) vs an arrow key (key-event path).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../bench/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const ROOT = new URL('.', import.meta.url).pathname;
const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), process.argv[2]], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim())));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
await page.addInitScript(() => window.addEventListener('keydown', () => { window.__keyAt = performance.now(); }, true));
await page.goto(url);
await page.waitForFunction(() => window.__herdrPaintedRevision > 0, null, { timeout: 30000 });
await page.mouse.click(500, 300);
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
async function measure(key, n) {
  const lat = [];
  for (let i = 0; i < n; i++) {
    const before = await page.evaluate(() => window.__herdrPaintedRevision);
    await page.keyboard.press(key);
    await page.waitForFunction((r) => window.__herdrPaintedRevision > r, before, { timeout: 3000 });
    lat.push(await page.evaluate(() => [window.__herdrPaintAt - window.__keyAt, window.__herdrInputAt - window.__keyAt]));
    await page.waitForTimeout(40);
  }
  const total = lat.map((l) => l[0]), sent = lat.map((l) => l[1]);
  return `key→paint p50 ${pct(total, 0.5).toFixed(1)} ms p95 ${pct(total, 0.95).toFixed(1)} ms | key→input sent p50 ${pct(sent, 0.5).toFixed(1)} ms`;
}
console.log(`text 'x'      : ${await measure('x', 25)}`);
console.log(`ArrowLeft     : ${await measure('ArrowLeft', 25)}`);
await page.keyboard.press('Control+U');
await browser.close(); server.kill();
