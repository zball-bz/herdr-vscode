// The scrollbar strip on the right edge: a drag of the thumb to the top
// scrolls to the oldest line, the down button steps back a line, a Shift+press
// near the bottom returns near the live end, and the strip stays out of text.
// Usage: node scrollbar.mjs <herdr-client.sock>
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../bench/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const ROOT = new URL('.', import.meta.url).pathname;
const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), process.argv[2]], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim())));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--enable-gpu', '--use-angle=vulkan', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 400 }, deviceScaleFactor: 1 });
const checks = [];
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${detail}`); };
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__herdrPaintedRevision > 0, null, { timeout: 60000 });
  await page.mouse.click(300, 200);
  await page.keyboard.type('clear; seq 1 500');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__herdrScrollOffset === 0, null, { timeout: 10000 });
  const cellWidth = await page.evaluate(() => window.__herdrCellWidth);
  const cellHeight = await page.evaluate(() => window.__herdrCellHeight);
  const x = 800 - 7; // the strip, flush with the view's right edge
  const rows = Math.floor(400 / cellHeight);
  const bottom = rows * cellHeight - 20; // above the down button
  await page.mouse.move(x, bottom);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(ROOT, 'shot-scrollbar-hover.png'), clip: { x: 800 - 60, y: 0, width: 60, height: 400 } });
  await page.mouse.down();
  for (let y = bottom; y >= 0; y -= 20) await page.mouse.move(x, y);
  await page.mouse.move(x, -5);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const top = await page.evaluate(() => window.__herdrScrollOffset);
  check('dragging the thumb to the top reaches the oldest line', top > 400, `offset ${top}`);
  await page.screenshot({ path: join(ROOT, 'shot-scrollbar-top.png') });
  await page.mouse.click(x, rows * cellHeight - 5);
  await page.waitForTimeout(400);
  const stepped = await page.evaluate(() => window.__herdrScrollOffset);
  check('the down button steps one line toward the live end', stepped === top - 1, `offset ${top} → ${stepped}`);
  await page.keyboard.down('Shift');
  await page.mouse.click(x, bottom);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => window.__herdrScrollOffset);
  check('a Shift+press near the bottom jumps near the live end', back < 40, `offset ${back}`);
  await page.mouse.move(300, 200);
  await page.mouse.down();
  await page.mouse.move(500, 200);
  await page.mouse.up();
  const after = await page.evaluate(() => window.__herdrScrollOffset);
  check('a drag in the text selects instead of scrolling', after === back, `offset ${after}`);
} finally {
  await browser.close();
  server.kill();
}
process.exit(checks.every(Boolean) ? 0 : 1);
