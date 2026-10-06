// Panel performance in a real VS Code, through e2e.mjs's isolated harness:
//
//   HERDR_E2E_PERF=1 [HERDR_E2E_FONT="Sarasa Mono SC"] [HERDR_E2E_RETAIN=1] node test/e2e.mjs
//
// Measures what a user feels: opening a panel, switching back to a hidden one,
// keystroke → painted echo (also while another panel floods output, since every
// panel's bytes pass through the one extension host), main-thread and process
// CPU under full-screen churn, and the memory each panel adds. Results go to
// $HERDR_E2E_DIR/perf.json.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHURN = `import os, sys, time
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
print(f"\\x1b[{rows};1H\\x1b[0mframes {f}")
`;

/** VS Code's processes: the Electron main process and its descendants. */
function processes(root) {
  const children = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(name));
    } catch {}
  }
  const all = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    all.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return all;
}

function kind(pid) {
  try {
    // Chromium rewrites its title into one space-separated string.
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/);
    const env = readFileSync(`/proc/${pid}/environ`, 'utf8');
    const entry = /VSCODE_ESM_ENTRYPOINT=([^\0]+)/.exec(env)?.[1] ?? '';
    if (entry.includes('extensionHost')) return 'extension-host';
    if (entry.includes('ptyHost')) return 'pty-host';
    if (entry) return entry.split('/').pop();
    const type = args.find((a) => a.startsWith('--type='))?.slice(7);
    const sub = args.find((a) => a.startsWith('--utility-sub-type='))?.slice(19);
    if (type) return sub ? `${type}:${sub.split('.').pop()}` : type;
    return args[0].endsWith('/code') ? 'main' : args[0].split('/').pop();
  } catch {
    return 'gone';
  }
}

function sample(root) {
  const out = new Map();
  for (const pid of processes(root)) {
    try {
      const pss = Number(/\nPss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0);
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').slice(readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 2).split(' ');
      out.set(pid, { kind: kind(pid), pssMB: pss / 1024, cpuS: (Number(stat[11]) + Number(stat[12])) / 100 });
    } catch {}
  }
  return out;
}

const totalMB = (s) => [...s.values()].reduce((n, p) => n + p.pssMB, 0);
const pct = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))];
const fmt = (values) => (values.length ? `p50 ${pct(values, 0.5).toFixed(1)} ms, p95 ${pct(values, 0.95).toFixed(1)} ms (n=${values.length})` : 'no samples');

export async function run(h) {
  const { page, codePid, alpha, beta, sleep, until, log } = h;
  const results = {};
  const note = (name, value) => {
    results[name] = value;
    log(`${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  };
  const script = join(h.DIR, 'churn.py');
  writeFileSync(script, CHURN);

  await h.runCommand('Herdr: Focus on Workspaces View');
  await until(async () => (await h.treeRows()).some((t) => t.includes('alpha')), 15000);
  await sleep(3000);
  const base = sample(codePid);
  note('baseline VS Code PSS', `${totalMB(base).toFixed(0)} MB in ${base.size} processes`);

  // Opening panels, and the memory each adds.
  let t = Date.now();
  await (await h.treeRow('alpha')).click();
  const frameA = await h.paintedFrame(alpha);
  note('open first panel → painted', `${Date.now() - t} ms; ${h.logLines(/first paint/).pop()?.replace(/^\S+ /, '')}`);
  await sleep(3000);
  const one = sample(codePid);
  const rowB = await h.treeRow('beta');
  await rowB.hover();
  t = Date.now();
  await rowB.locator('.action-label[aria-label="Open Pane to the Side"]').click();
  const frameB = await h.paintedFrame(beta);
  note('open second panel → painted', `${Date.now() - t} ms; ${h.logLines(/first paint/).pop()?.replace(/^\S+ /, '')}`);
  await sleep(3000);
  const two = sample(codePid);
  const added = (before, after) =>
    [...after]
      .map(([pid, p]) => [pid, p, p.pssMB - (before.get(pid)?.pssMB ?? 0)])
      .filter(([, , delta]) => Math.abs(delta) >= 5)
      .map(([pid, p, delta]) => `${p.kind}${before.has(pid) ? '' : ' (new)'} ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}`)
      .join(', ');
  note('PSS added by the first panel', `${(totalMB(one) - totalMB(base)).toFixed(0)} MB: ${added(base, one)}`);
  note('PSS added by the second panel', `${(totalMB(two) - totalMB(one)).toFixed(0)} MB: ${added(one, two)}`);
  const inside = await frameA.evaluate(() => ({
    wasmMB: (window.__herdrWasmBytes?.() ?? 0) / 1048576,
    jsHeapMB: (performance.memory?.usedJSHeapSize ?? 0) / 1048576,
  }));
  note('inside one panel', `WASM heap ${inside.wasmMB.toFixed(0)} MB, JS heap ${inside.jsHeapMB.toFixed(0)} MB`);

  // Keystroke → painted echo, measured inside the webview on one clock.
  const latency = async (frame, count) => {
    await frame.evaluate(() => {
      if (window.__keyHook) return;
      window.__keyHook = true;
      window.addEventListener('keydown', () => (window.__keyAt = performance.now()), true);
    });
    const samples = [];
    for (let i = 0; i < count; i++) {
      for (const key of ['x', 'Backspace']) {
        const before = await frame.evaluate(() => window.__keyAt ?? 0);
        await page.keyboard.press(key);
        const ms = await frame
          .waitForFunction((b) => window.__keyAt > b && window.__herdrPaintAt > window.__keyAt && window.__herdrPaintAt - window.__keyAt, before, { timeout: 3000, polling: 'raf' })
          .then((handle) => handle.jsonValue())
          .catch(() => undefined);
        if (typeof ms === 'number') samples.push(ms);
        await sleep(60);
      }
    }
    return samples;
  };
  await h.focusFrame(frameB);
  note('keystroke → painted echo (idle)', fmt(await latency(frameB, 15)));

  // Full-screen churn in alpha: its renderer, the extension host, and beta's typing.
  await h.focusFrame(frameA);
  // Metrics come per renderer target: the nearest frame with a session of its own.
  let cdp;
  for (let frame = frameA; frame && !cdp; frame = frame.parentFrame()) {
    cdp = await page.context().newCDPSession(frame).catch(() => undefined);
  }
  await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await page.keyboard.type(`clear; python3 ${script} 9`);
  await page.keyboard.press('Enter');
  await sleep(1000);
  const m0 = await metric();
  const p0 = await frameA.evaluate(() => window.__herdrPaints ?? 0);
  const c0 = sample(codePid);
  const w0 = Date.now();
  await sleep(3000);
  const seconds = (Date.now() - w0) / 1000;
  const m1 = await metric();
  const p1 = await frameA.evaluate(() => window.__herdrPaints ?? 0);
  const c1 = sample(codePid);
  const cpu = [...c1]
    .map(([pid, p]) => [p.kind, (p.cpuS - (c0.get(pid)?.cpuS ?? p.cpuS)) / seconds])
    .filter(([, share]) => share >= 0.03)
    .sort((a, b) => b[1] - a[1])
    .map(([k, share]) => `${k} ${(share * 100).toFixed(0)}%`)
    .join(', ');
  note(
    'churn: flooding panel',
    `${((p1 - p0) / seconds).toFixed(0)} paints/s, main thread busy ${((100 * (m1.TaskDuration - m0.TaskDuration)) / seconds).toFixed(0)}%, ${((1000 * (m1.TaskDuration - m0.TaskDuration)) / Math.max(1, p1 - p0)).toFixed(2)} ms/paint`,
  );
  note('churn: process CPU (one core = 100%)', cpu);
  await h.focusFrame(frameB);
  note('keystroke → painted echo in the other panel during churn', fmt(await latency(frameB, 10)));
  await sleep(4000);

  // Switching back to a hidden panel.
  const reattach = [];
  let current = frameA;
  for (let i = 0; i < 4; i++) {
    // Ctrl+P would reach the shell: open a file in alpha's group as a link click does.
    await h.focusFrame(current);
    const link = { type: 'openLink', kind: 'path', target: 'sample.txt', paneId: alpha, cwd: join(h.DIR, 'workspace') };
    await current.evaluate((json) => window.__herdr.host.event(json), JSON.stringify(link));
    await until(() => page.evaluate(() => document.querySelector('.tabs-container .tab.active')?.textContent?.includes('sample.txt')), 5000);
    await sleep(1500);
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.tabs-container .tab')].map((t) => `${t.classList.contains('active') ? '*' : ''}${t.textContent.trim()}`));
    log(`tabs ${tabs.join(' | ')}; loaded ${Object.keys(await h.herdrFrames()).join(',')}`);
    t = Date.now();
    await h.editorTab('alpha').click();
    const shown = await h.paintedFrame(alpha, 15000);
    if (!shown) {
      await page.screenshot({ path: join(h.DIR, 'perf-reattach.png') });
      log(`alpha did not paint again; loaded ${Object.keys(await h.herdrFrames()).join(',')}`);
      break;
    }
    reattach.push(Date.now() - t);
    current = shown;
    await sleep(500);
  }
  note('switch back to a hidden panel → painted', `${fmt(reattach)}; ${h.logLines(/first paint/).pop()?.replace(/^\S+ /, '')}`);
  writeFileSync(join(h.DIR, 'perf.json'), JSON.stringify(results, null, 2));
}
