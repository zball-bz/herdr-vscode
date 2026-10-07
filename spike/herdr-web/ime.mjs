// Where does the platform IME panel anchor? The hidden textarea GPUI's browser
// platform composes in must sit on the terminal caret while composing.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../bench/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const ROOT = new URL('.', import.meta.url).pathname;
const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), process.argv[2]], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
const url = await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim())));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 900, height: 300 } });
const cdp = await page.context().newCDPSession(page);
await page.goto(url);
await page.waitForFunction(() => window.__herdrPaintedRevision > 0 && window.__herdrCellWidth > 0, null, { timeout: 30000 });
await page.mouse.click(450, 150);
await page.keyboard.type('clear');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.keyboard.type('echo 你好 ');
await page.waitForTimeout(400);
await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
await page.waitForTimeout(400);
const geometry = await page.evaluate(() => {
  const area = document.querySelector('textarea').getBoundingClientRect();
  return { area: { x: area.x, y: area.y, h: area.height }, cell: { w: window.__herdrCellWidth, h: window.__herdrCellHeight }, pad: window.__herdrPaddingLeft };
});
await page.screenshot({ path: join(ROOT, 'shot-ime.png'), clip: { x: 0, y: 0, width: 700, height: 80 } });
await cdp.send('Input.insertText', { text: '世界' });
await page.keyboard.press('Control+U');
await browser.close(); server.kill();
// After `clear` the prompt row is 0; the caret column follows the prompt and "echo 你好 ".
const caretRow = Math.round(geometry.area.y / geometry.cell.h);
console.log(`textarea at x=${geometry.area.x.toFixed(1)} y=${geometry.area.y.toFixed(1)} h=${geometry.area.h.toFixed(1)}  (cell ${geometry.cell.w.toFixed(2)}x${geometry.cell.h})`);
console.log(`→ column ${((geometry.area.x - geometry.pad) / geometry.cell.w).toFixed(1)}, row ${caretRow}`);
