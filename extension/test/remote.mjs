// Remote machines end to end, over real SSH to this machine: a private sshd
// (its own host key, one throwaway client key, no passwords) listens on
// 127.0.0.1 and, when Tailscale is up, on this machine's tailnet address; an
// `ssh` wrapper on VS Code's PATH uses only those keys. Each remote machine is
// an isolated herdr session, which the bridge starts on first connect and the
// test stops at the end. Run from e2e.mjs's main flow.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const SESSIONS = ['e2eloop', 'e2etail'];

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

function tailscaleAddress() {
  try {
    return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Keys, sshd and the client wrapper; returns how to stop sshd. */
async function sshLab(dir, addresses) {
  const lab = join(dir, 'sshlab');
  mkdirSync(lab, { recursive: true, mode: 0o700 });
  for (const key of ['host_key', 'client_key']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `herdr-e2e-${key}`, '-f', join(lab, key)]);
  writeFileSync(join(lab, 'authorized_keys'), readFileSync(join(lab, 'client_key.pub')));
  const port = await freePort();
  writeFileSync(
    join(lab, 'sshd_config'),
    [
      `Port ${port}`,
      ...addresses.map((address) => `ListenAddress ${address}`),
      `HostKey ${join(lab, 'host_key')}`,
      `PidFile ${join(lab, 'sshd.pid')}`,
      `AuthorizedKeysFile ${join(lab, 'authorized_keys')}`,
      'PubkeyAuthentication yes',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'StrictModes no',
      `AllowUsers ${userInfo().username}`,
    ].join('\n') + '\n',
  );
  const hostKey = readFileSync(join(lab, 'host_key.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
  writeFileSync(join(lab, 'known_hosts'), addresses.map((address) => `[${address}]:${port} ${hostKey}`).join('\n') + '\n');
  writeFileSync(
    join(lab, 'ssh_config'),
    `Host *\n  IdentityFile ${join(lab, 'client_key')}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${join(lab, 'known_hosts')}\n  GlobalKnownHostsFile /dev/null\n`,
  );
  // VS Code's PATH starts with DIR/bin: its ssh uses only the lab's keys.
  writeFileSync(join(dir, 'bin', 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${join(lab, 'ssh_config')} "$@"\n`);
  chmodSync(join(dir, 'bin', 'ssh'), 0o755);
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(lab, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  sshd.stderr.on('data', (chunk) => (log = (log + chunk).slice(-4000)));
  return { port, stop: () => sshd.kill(), log: () => log };
}

export async function run(h) {
  const { page, DIR, sleep, until, log, record, shot, treeRow, herdrFrames, focusFrame, logLines, SETTINGS } = h;
  const user = userInfo().username;
  const tailnet = tailscaleAddress();
  const lab = await sshLab(DIR, ['127.0.0.1', ...(tailnet ? [tailnet] : [])]);
  const herdr = (session, ...args) => execFileSync('herdr', ['--session', session, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const quickInput = async (text) => {
    const input = page.locator('.quick-input-widget:not([style*="display: none"]) input').first();
    await input.waitFor({ timeout: 5000 });
    await input.fill(text);
    await sleep(200);
    await page.keyboard.press('Enter');
    await sleep(300);
  };
  const addMachine = async (target, session, name) => {
    await page.locator('.part.sidebar [aria-label="Add Remote Machine…"]').first().click();
    await quickInput(target);
    await quickInput(session);
    await quickInput(name);
  };
  const stored = () => JSON.parse(readFileSync(SETTINGS, 'utf8'))['herdr.machines'] ?? [];
  try {
    log(`sshd on port ${lab.port} (127.0.0.1${tailnet ? `, ${tailnet}` : ''})`);
    // 1. Add the loopback machine from the view title, as a user would.
    const loopTarget = `ssh://${user}@127.0.0.1:${lab.port}`;
    await addMachine(loopTarget, SESSIONS[0], 'loopback');
    const added = await until(async () => stored().find((machine) => machine.target === loopTarget), 20000);
    const connected = await until(async () => {
      const text = await treeRow('loopback').textContent().catch(() => '');
      return text && !/not connected|connecting/.test(text) ? text : undefined;
    }, 30000);
    record(
      'Add Remote Machine (SSH loopback): probed, stored in herdr.machines, connected in the tree',
      !!added && !!connected,
      `${JSON.stringify(added)}; tree row: ${connected}; ${logLines(/add machine/).pop()?.replace(/^\S+ /, '')}`,
    );

    // 2. A terminal on it: the bridge started the remote session; typing reaches it there.
    const row = treeRow('loopback');
    await row.hover();
    await row.locator('.action-label[aria-label="New Terminal"]').first().click();
    const machine = `ssh:${loopTarget}#${SESSIONS[0]}`;
    const remote = await until(async () => {
      const entry = Object.values(await herdrFrames()).find((frame) => frame.machine === machine && frame.paints > 0);
      return entry;
    }, 30000, 300);
    let echoed;
    if (remote) {
      await focusFrame(remote.frame);
      await page.keyboard.type('echo from-remote-loopback');
      await page.keyboard.press('Enter');
      echoed = await until(async () => herdr(SESSIONS[0], 'pane', 'read', remote.paneId, '--source', 'recent-unwrapped', '--lines', '5').includes('\nfrom-remote-loopback'), 8000);
    }
    // For reference: keystroke → painted echo through ssh (loopback: ssh's own cost).
    let latency = 'not measured';
    if (remote) {
      await remote.frame.evaluate(() => window.addEventListener('keydown', () => (window.__keyAt = performance.now()), true));
      const samples = [];
      for (let i = 0; i < 10; i++) {
        for (const key of ['x', 'Backspace']) {
          const before = await remote.frame.evaluate(() => window.__keyAt ?? 0);
          await page.keyboard.press(key);
          const ms = await remote.frame
            .waitForFunction((b) => window.__keyAt > b && window.__herdrPaintAt > window.__keyAt && window.__herdrPaintAt - window.__keyAt, before, { timeout: 3000, polling: 'raf' })
            .then((handle) => handle.jsonValue())
            .catch(() => undefined);
          if (typeof ms === 'number') samples.push(ms);
          await sleep(60);
        }
      }
      samples.sort((a, b) => a - b);
      if (samples.length) latency = `p50 ${samples[samples.length >> 1].toFixed(1)} ms, p95 ${samples[Math.floor(samples.length * 0.95)].toFixed(1)} ms (n=${samples.length})`;
    }
    const title = await page.evaluate(() => [...document.querySelectorAll('.tabs-container .tab .label-name')].map((e) => e.textContent?.trim()).find((t) => t?.includes('· loopback')));
    record(
      'a terminal on the remote machine: panel over SSH, input reaches the remote session',
      !!remote && !!echoed && !!title,
      `panel ${remote?.paneId} on ${machine}; title ${JSON.stringify(title)}; keystroke → echo over ssh ${latency}; ${await shot('shot-11-remote-machine')}`,
    );

    // 3. The same machine over Tailscale, as a second remote machine.
    if (tailnet) {
      const tailTarget = `ssh://${user}@${tailnet}:${lab.port}`;
      await addMachine(tailTarget, SESSIONS[1], 'tailnet');
      const tailConnected = await until(async () => {
        const text = await treeRow('tailnet').textContent().catch(() => '');
        return text && !/not connected|connecting/.test(text) ? text : undefined;
      }, 30000);
      record('Add Remote Machine over the Tailscale address connects too', !!tailConnected, `${tailTarget}: ${tailConnected}`);
    } else {
      record('Add Remote Machine over the Tailscale address (skipped: tailscale is not up)', true, 'no tailnet address');
    }

    // 4. A login that fails is explained before anything is stored.
    await addMachine(`ssh://${user}@127.0.0.1:1`, 'default', 'nowhere');
    const dialog = page.locator('.monaco-dialog-box');
    const explained = await dialog.innerText({ timeout: 20000 }).catch(() => '');
    await dialog.locator('.monaco-button', { hasText: 'Cancel' }).click({ timeout: 3000 }).catch(() => page.keyboard.press('Escape'));
    record(
      'a failing login is explained (with a fix) and not stored',
      /refused|failed/i.test(explained) && /To fix/.test(explained) && !stored().some((machine) => machine.name === 'nowhere'),
      explained.replace(/\s+/g, ' ').slice(0, 200),
    );

    // 5. Remove the loopback machine: its panel closes, the remote pane keeps running.
    await treeRow('loopback').click({ button: 'right' });
    await sleep(500);
    await shot('shot-12-machine-menu');
    await page.locator('.monaco-menu .action-label', { hasText: 'Remove Machine' }).first().click({ timeout: 5000 });
    await page.locator('.monaco-dialog-box .monaco-button', { hasText: 'Remove' }).click({ timeout: 5000 });
    const gone = await until(async () => !stored().some((entry) => entry.target === loopTarget) && !Object.values(await herdrFrames()).some((frame) => frame.machine === machine), 10000);
    const stillRunning = remote ? herdr(SESSIONS[0], 'pane', 'list').includes(remote.paneId) : false;
    record('Remove Machine: settings entry and panel gone, the remote pane keeps running', !!gone && stillRunning, `remaining machines ${JSON.stringify(stored().map((entry) => entry.name))}`);
  } finally {
    lab.stop();
    for (const session of SESSIONS) {
      for (const verb of ['stop', 'delete']) {
        try {
          execFileSync('herdr', ['session', verb, session], { stdio: 'ignore' });
        } catch {}
      }
    }
  }
}
