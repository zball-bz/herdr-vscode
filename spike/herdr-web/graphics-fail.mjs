// With 3D APIs disabled the view must report why it cannot start; with a GPU it reports ready.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../bench/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const ROOT = new URL('.', import.meta.url).pathname;
const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), process.argv[2]], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim())));
for (const [label, args] of [
  ['no 3D APIs', ['--disable-3d-apis', '--disable-gpu']],
  ['GPU', ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu']],
]) {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args });
  const page = await browser.newPage();
  const t0 = Date.now();
  await page.goto(url);
  const event = await page
    .waitForFunction(() => window.__herdrEvents?.find((e) => e.type === 'ready' || e.type === 'error'), null, { timeout: 15000 })
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  console.log(`${label.padEnd(10)} → ${JSON.stringify(event)} after ${Date.now() - t0} ms`);
  await browser.close();
}
server.kill();
