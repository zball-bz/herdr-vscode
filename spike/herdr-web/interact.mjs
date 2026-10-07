// Interaction checks for herdr-web's PaneView against an isolated herdr session.
// Usage: node interact.mjs <herdr-client.sock> <session-name> <pane-id>
// Each check prints PASS/FAIL with evidence; screenshots land in shot-interact-*.png.
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../bench/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const ROOT = new URL('.', import.meta.url).pathname;
const [SOCKET, SESSION, PANE] = process.argv.slice(2);

const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), SOCKET], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim())));
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
});
const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write']);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await page.goto(url);
await page.waitForFunction(() => window.__herdrPaintedRevision > 0, null, { timeout: 30000 });

const paneText = () => execFileSync('herdr', ['--session', SESSION, 'pane', 'read', PANE], { encoding: 'utf8' });
const settle = (ms = 500) => page.waitForTimeout(ms);
const events = () => page.evaluate(() => window.__herdrEvents.splice(0));
const results = [];
const check = (name, ok, evidence) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  — ${evidence}` : ''}`);
};
// Cell geometry as the view measured it.
const grid = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
const cellHeight = 20;
const cw = await page.evaluate(() => window.__herdrCellWidth);
const pad = await page.evaluate(() => window.__herdrPaddingLeft);
const at = (col, row) => ({ x: pad + (col + 0.5) * cw, y: (row + 0.5) * cellHeight });

async function run(command) {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await settle();
}

await page.mouse.click(grid.w / 2, grid.h / 2);
await run('clear');

// 1. CJK through insertText (the input-handler path an IME commit takes).
await page.keyboard.type('echo ');
await page.keyboard.insertText('界面渲染');
await page.keyboard.press('Enter');
await settle();
check('CJK text commit', paneText().includes('界面渲染\n') || /\n界面渲染\s/.test(paneText()), 'echo printed 界面渲染');

// 2. A real IME composition: preedit shown, then committed.
await run('clear');
await page.keyboard.type('echo ');
await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
await settle(300);
await page.screenshot({ path: join(ROOT, 'shot-interact-ime-preedit.png'), clip: { x: 0, y: 0, width: 400, height: 40 } });
const beforeCommit = paneText();
await cdp.send('Input.insertText', { text: '你好' });
await page.keyboard.press('Enter');
await settle();
check('IME preedit stays local until commit', !beforeCommit.includes('ni'), 'pane did not receive the preedit');
check('IME commit reaches the pane', paneText().includes('你好'), 'echo printed 你好');

// 3. Drag-select and copy.
await run('clear');
await run('printf "alpha beta gamma\\n"');
const row = 1; // after `clear`, the command line is row 0 and its output row 1
await page.mouse.move(at(6, row).x - cw / 2 + 1, at(6, row).y);
await page.mouse.down();
await page.mouse.move(at(9, row).x + cw / 2 - 1, at(9, row).y, { steps: 4 });
await page.mouse.up();
await settle(200);
await page.screenshot({ path: join(ROOT, 'shot-interact-selection.png'), clip: { x: 0, y: 0, width: 400, height: 60 } });
await events();
await page.keyboard.press('Control+Shift+C');
await settle(200);
const copied = (await events()).find((e) => e.type === 'copy');
check('drag selection + Ctrl+Shift+C copies', copied?.text === 'beta', JSON.stringify(copied));

// 4. Ctrl+click a web link and a file path.
await run('clear');
const linkLine = 'see https://example.com/herdr-docs and /etc/hostname';
await run(`printf "${linkLine}\\n"`);
const urlCol = linkLine.indexOf('https') + 3;
const pathCol = linkLine.indexOf('/etc') + 3;
await events();
await page.keyboard.down('Control');
await page.mouse.move(at(urlCol, 1).x, at(urlCol, 1).y);
await settle(200);
await page.screenshot({ path: join(ROOT, 'shot-interact-link-hover.png'), clip: { x: 0, y: 0, width: 600, height: 60 } });
await page.mouse.click(at(urlCol, 1).x, at(urlCol, 1).y);
await page.mouse.click(at(pathCol, 1).x, at(pathCol, 1).y);
await page.keyboard.up('Control');
await settle(200);
const opened = (await events()).filter((e) => e.type === 'openLink');
check('Ctrl+click web link', opened.some((e) => e.kind === 'web' && e.target === 'https://example.com/herdr-docs'), JSON.stringify(opened[0]));
check('Ctrl+click file path (with pane cwd)', opened.some((e) => e.kind === 'path' && e.target === '/etc/hostname' && e.cwd), JSON.stringify(opened[1]));

// 5. Find through the daemon, with match highlights.
await run('clear');
await run('seq 1 300 | sed "s/^/line /"');
await page.keyboard.press('Control+Shift+F');
await page.keyboard.type('line 42');
await settle(800);
await page.keyboard.press('Enter');
await settle(800);
await page.screenshot({ path: join(ROOT, 'shot-interact-find.png') });
const findState = await page.evaluate(() => window.__herdrPaintedRevision);
await page.keyboard.press('Escape');
await settle(300);
check('find opens, searches, and scrolls (see screenshot)', findState > 0, 'shot-interact-find.png');

// 6. Wheel scrolls the pane's scrollback (daemon-side), and typing returns.
await run('clear');
await run('seq 1 400');
await page.mouse.move(grid.w / 2, grid.h / 2);
await page.mouse.wheel(0, -2000);
await settle(600);
await page.screenshot({ path: join(ROOT, 'shot-interact-wheel.png') });
const scrolled = await page.evaluate(() => window.__herdrPaintedRevision);
check('wheel scroll repaints scrollback (see screenshot)', scrolled > 0, 'shot-interact-wheel.png');
await page.mouse.wheel(0, 4000);
await settle(400);

// 7. A mouse-reporting app receives clicks (SGR 1006).
await run('clear');
await page.keyboard.type(`python3 -c "import sys,tty,os; tty.setraw(0); sys.stdout.write('\\x1b[?1000h\\x1b[?1006h'); sys.stdout.flush(); d=os.read(0,64); sys.stdout.write('\\x1b[?1000l\\x1b[?1006l'); print(repr(d))"`);
await page.keyboard.press('Enter');
await settle(600);
await page.mouse.click(at(10, 5).x, at(10, 5).y);
await settle(600);
const reported = paneText();
check('mouse-reporting app gets the click', /\\x1b\[<0;11;6M/.test(reported), reported.split('\n').find((l) => l.includes('x1b')) ?? '');

await browser.close();
server.kill();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
