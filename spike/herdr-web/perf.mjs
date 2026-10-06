// Main-thread cost of herdr-web under full-screen churn and at idle, with a
// CPU profile of where the time goes. Usage: node perf.mjs <sock> [dpr] [width] [height]
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../bench/package.json', import.meta.url));
const { chromium } = require('playwright-core');
// The workload: full-screen TUI-style churn, as fast as the pty takes it.
const CHURN = join(tmpdir(), 'herdr-web-churn.py');
writeFileSync(
  CHURN,
  `import os, sys, time
words = "const let return function import export async await if else for while class new this".split()
cols, rows = os.get_terminal_size()
end, f = time.time() + float(sys.argv[1]), 0
while time.time() < end:
    out = []
    for y in range(rows - 1):
        line = ""
        while len(line) < cols - 12:
            line += words[(y * 13 + f + len(line)) % len(words)] + " "
        out.append(f"\\x1b[{y + 1};1H\\x1b[3{(y + f) % 8}m{line}\\x1b[0m\\x1b[K")
    sys.stdout.write("".join(out)); sys.stdout.flush(); f += 1
`,
);
const ROOT = new URL('.', import.meta.url).pathname;
const [sock, dpr = '1', width = '1400', height = '900'] = process.argv.slice(2);
const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), sock], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim())));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--enable-gpu', '--use-angle=vulkan', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +width, height: +height }, deviceScaleFactor: +dpr });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
async function window_(label, seconds, during) {
  const m0 = await metrics(); const p0 = await page.evaluate(() => window.__herdrPaints ?? 0);
  const t0 = Date.now(); await during(); const elapsed = (Date.now() - t0) / 1000;
  const m1 = await metrics(); const p1 = await page.evaluate(() => window.__herdrPaints ?? 0);
  const busy = (m1.TaskDuration - m0.TaskDuration) / elapsed;
  const script = (m1.ScriptDuration - m0.ScriptDuration) / elapsed;
  console.log(`${label.padEnd(8)} paints/s ${((p1 - p0) / elapsed).toFixed(1).padStart(5)}  main thread busy ${(busy * 100).toFixed(1)}%  script ${(script * 100).toFixed(1)}%  ms/paint ${((m1.TaskDuration - m0.TaskDuration) * 1000 / Math.max(1, p1 - p0)).toFixed(2)}  heap ${(m1.JSHeapUsedSize / 1048576).toFixed(0)} MB`);
}
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__herdrPaintedRevision > 0, null, { timeout: 60000 });
  await page.mouse.click(300, 200);
  await page.keyboard.type('clear'); await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await window_('idle', 3, () => page.waitForTimeout(3000));
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await page.keyboard.type(`python3 ${CHURN} 6`); await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await cdp.send('Profiler.start');
  await window_('churn', 4, () => page.waitForTimeout(4000));
  const { profile } = await cdp.send('Profiler.stop');
  writeFileSync(join(ROOT, 'perf.cpuprofile'), JSON.stringify(profile));
  // Self time per function.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas; let total = 0;
  profile.samples.forEach((id, i) => { const n = byId.get(id); const key = n.callFrame.functionName || '(anon ' + n.callFrame.url.split('/').pop() + ')'; const d = dt[i] / 1000; self.set(key, (self.get(key) ?? 0) + d); total += d; });
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 40);
  for (const [name, ms] of top) console.log(`${(100 * ms / total).toFixed(1).padStart(5)}%  ${name.slice(0, 140)}`);
  await page.waitForTimeout(2500);
  await window_('after', 3, () => page.waitForTimeout(3000));
} finally { await browser.close(); server.kill(); }
