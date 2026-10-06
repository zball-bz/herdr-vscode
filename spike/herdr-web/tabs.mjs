// Two pages pinned to different herdr tabs: each shows and types into its own pane.
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../bench/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const ROOT = new URL('.', import.meta.url).pathname;
const [SOCKET, SESSION] = process.argv.slice(2);
const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), SOCKET], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim())));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] });
const read = (pane) => execFileSync('herdr', ['--session', SESSION, 'pane', 'read', pane], { encoding: 'utf8' });
async function open(tab) {
  const page = await browser.newPage({ viewport: { width: 700, height: 220 } });
  await page.goto(`${url}?tab=${tab}`);
  await page.waitForFunction(() => window.__herdrPaintedRevision > 0, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  return page;
}
const one = await open('w1:t1');
const two = await open('w1:t2');
for (const [page, word] of [[one, 'from-tab-one'], [two, 'from-tab-two']]) {
  await page.mouse.click(350, 110);
  await page.keyboard.type(`clear; echo ${word}`);
  await page.keyboard.press('Enter');
}
await one.waitForTimeout(800);
await one.screenshot({ path: join(ROOT, 'shot-tab-one.png') });
await two.screenshot({ path: join(ROOT, 'shot-tab-two.png') });
const p1 = read('w1:p1'), p2 = read('w1:p2');
console.log(`pane w1:p1 got tab-one text: ${p1.includes('from-tab-one')}, tab-two text: ${p1.includes('from-tab-two')}`);
console.log(`pane w1:p2 got tab-two text: ${p2.includes('from-tab-two')}, tab-one text: ${p2.includes('from-tab-one')}`);
// Hidden views stop receiving surfaces.
const before = await two.evaluate(() => window.__herdrRevision);
await two.evaluate(() => window.herdrHostEvent?.(JSON.stringify({ type: 'visibility', visible: false })));
await browser.close(); server.kill();
