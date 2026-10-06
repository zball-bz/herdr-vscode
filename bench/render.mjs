// Usage: node render.mjs [--engines=a,b] [--workloads=tui,scroll,fgonly,fullscreen,flood] [--dpr=1] [--shots] [--json=out.json]
// Drives render.html in Chrome and reports, per engine × workload:
//   main-thread busy ms (CDP TaskDuration), renderer-process CPU ms (all threads incl. workers),
//   GPU-process CPU ms, wall ms, and frame-interval stats from requestAnimationFrame.
import http from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = new URL('.', import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const ENGINES = (args.engines || 'xterm-webgl,gespenst-main,gespenst-worker,ghostty-web,xterm-dom').split(',');
const WORKLOADS = (args.workloads || 'tui,scroll,fullscreen,flood').split(',');
const DPR = Number(args.dpr || 1);
const HEADLESS = args.headed ? false : true;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json' };
const server = http.createServer((req, res) => {
  const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }).end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- per-process CPU accounting for Chrome children of this Node process
const TICK = 1000 / 100; // ms per clock tick (USER_HZ = 100 on Linux)
function procTable() {
  const t = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8');
      t.set(Number(d), { ppid: Number(f[1]), cpu: (Number(f[11]) + Number(f[12])) * TICK, type: (cmd.match(/--type=([a-z-]+)/) || [, 'browser'])[1] });
    } catch {}
  }
  return t;
}
function cpuByType() {
  const t = procTable(), out = {};
  for (const [pid, p] of t) {
    let a = p.ppid, mine = false;
    for (let i = 0; i < 12 && a > 1; i++) { if (a === process.pid) { mine = true; break; } a = t.get(a)?.ppid ?? 0; }
    if (!mine) continue;
    out[p.type] = (out[p.type] || 0) + p.cpu;
  }
  return out;
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: HEADLESS,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-unsafe-webgpu', '--use-angle=vulkan', '--enable-features=Vulkan',
         ...(HEADLESS ? ['--enable-gpu'] : ['--ozone-platform=wayland'])],
});

async function openPage(engine) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: DPR });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${engine}] pageerror:`, e.message));
  await page.goto(`${BASE}/render.html?engine=${engine}`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 30000 });
  return { ctx, page };
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

{
  const { ctx, page } = await openPage('xterm-dom');
  console.log('Chrome', browser.version(), ' GPU:', JSON.stringify(await page.evaluate(() => window.__gpuInfo())), ' DPR', DPR);
  await ctx.close();
}
if (args.probe) { await browser.close(); server.close(); process.exit(0); }

const rows = [];
for (const workload of WORKLOADS) {
  for (const engine of ENGINES) {
    const { ctx, page } = await openPage(engine);
    const backend = (await page.evaluate(() => window.__ready)).backend;
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    const m0 = await m(), c0 = cpuByType();
    const { wallMs, intervals } = await page.evaluate((w) => window.__run(w), workload);
    const m1 = await m(), c1 = cpuByType();
    if (args.shots) await page.screenshot({ path: join(ROOT, `shot-${workload}-${engine}.png`) });
    const iv = intervals.slice(2);
    rows.push({
      workload, engine, backend,
      wall: wallMs,
      main: (m1.TaskDuration - m0.TaskDuration) * 1000,
      renderer: (c1.renderer || 0) - (c0.renderer || 0),
      gpu: (c1['gpu-process'] || 0) - (c0['gpu-process'] || 0),
      fps: 1000 / (iv.reduce((a, b) => a + b, 0) / iv.length),
      p95: pct(iv, 0.95), max: Math.max(...iv), jank: iv.filter((x) => x > 33.4).length, frames: iv.length,
    });
    const r = rows.at(-1);
    console.log(`${workload.padEnd(10)} ${engine.padEnd(16)} ${backend.padEnd(15)} wall ${r.wall.toFixed(0).padStart(6)}ms  main ${r.main.toFixed(0).padStart(6)}ms  rendererCPU ${r.renderer.toFixed(0).padStart(6)}ms  gpuCPU ${r.gpu.toFixed(0).padStart(5)}ms  fps ${r.fps.toFixed(1).padStart(5)}  p95 ${r.p95.toFixed(1).padStart(6)}ms  max ${r.max.toFixed(0).padStart(5)}ms  >33ms ${r.jank}/${r.frames}`);
    await ctx.close();
  }
}
if (args.json) (await import('node:fs')).writeFileSync(join(ROOT, args.json), JSON.stringify(rows, null, 1));
await browser.close();
server.close();
