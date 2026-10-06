// Renders shell-printed CJK, emoji, combining and box-drawing text (typed as ASCII escapes).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../bench/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const ROOT = new URL('.', import.meta.url).pathname;
const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), process.argv[2]], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim())));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 300 }, deviceScaleFactor: 2 });
await page.goto(url);
await page.waitForFunction(() => window.__herdrPaintedRevision > 0, null, { timeout: 30000 });
await page.mouse.click(500, 150);
// Printed from a file: the text arrives from the shell, not through typing.
const sample = join(tmpdir(), 'herdr-web-utf8-sample.txt');
writeFileSync(sample, '中文 日本語 한국어 ✓ ✗ … — → 😀 👍🏽 é ┌─┬─┐ │█│▒│ └─┴─┘\n');
await page.keyboard.type(`clear; cat ${sample}`);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
await page.screenshot({ path: join(ROOT, 'shot-cjk.png'), clip: { x: 590, y: 0, width: 300, height: 22 } });
await browser.close(); server.kill();
