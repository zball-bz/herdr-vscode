// Unit tests for the extension-host modules that do not need VS Code.
// Run: npm run test:unit   (bundles src/*.ts with esbuild, `vscode` stubbed)
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const work = mkdtempSync(join(process.env.HERDR_TEST_TMP ?? tmpdir(), 'h-'));
let m;

before(async () => {
  const entry = join(work, 'entry.ts');
  writeFileSync(
    entry,
    ['keys', 'socket', 'fonts', 'transport', 'links', 'api', 'model', 'machines', 'colors/color', 'colors/scheme', 'colors/formats', 'colors/optimize']
      .map((name) => `export * from ${JSON.stringify(join(root, 'src', name))};`)
      .join('\n'),
  );
  const stub = join(work, 'vscode.js');
  writeFileSync(
    stub,
    'export const workspace = {}; export const window = {}; export const env = {}; export const commands = {}; export const Uri = {};' +
      'export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };' +
      'export class EventEmitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }',
  );
  await esbuild.build({
    entryPoints: [entry],
    outfile: join(work, 'bundle.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { vscode: stub },
    logLevel: 'error',
  });
  m = await import(pathToFileURL(join(work, 'bundle.mjs')));
});
after(() => rmSync(work, { recursive: true, force: true }));

describe('keys', () => {
  it('canonicalizes events and settings the same way', () => {
    const event = (code, mods = {}) => ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
    assert.equal(m.eventKey(event('KeyP', { ctrlKey: true })), 'ctrl+p');
    assert.equal(m.eventKey(event('KeyC', { ctrlKey: true, shiftKey: true })), 'ctrl+shift+c');
    assert.equal(m.eventKey(event('Backquote', { ctrlKey: true })), 'ctrl+`');
    assert.equal(m.eventKey(event('F1')), 'f1');
    assert.equal(m.eventKey(event('ShiftLeft', { shiftKey: true })), undefined);
    assert.equal(m.normalizeKey('Shift+Ctrl+P'), 'ctrl+shift+p');
    assert.equal(m.normalizeKey('cmd+f'), 'meta+f');
    assert.equal(m.normalizeKey('ctrl+shift+`'), 'ctrl+shift+`');
    assert.equal(m.normalizeKey('hyper+x'), undefined);
  });
});

describe('socket path', () => {
  const env = { HOME: '/home/u' };
  it('follows herdr discovery', () => {
    assert.equal(m.localSocketPath('', 'default', env), '/home/u/.config/herdr/herdr-client.sock');
    assert.equal(m.localSocketPath('', 'work', { ...env, XDG_CONFIG_HOME: '/x' }), '/x/herdr/sessions/work/herdr-client.sock');
    assert.equal(m.localSocketPath('', 'work', { ...env, HERDR_CLIENT_SOCKET_PATH: '/s/c.sock' }), '/s/c.sock');
    assert.equal(m.localSocketPath('', 'default', { ...env, HERDR_SOCKET_PATH: '/r/herdr.sock' }), '/r/herdr-client.sock');
    assert.equal(m.localSocketPath('/explicit.sock', 'work', { ...env, HERDR_CLIENT_SOCKET_PATH: '/s/c.sock' }), '/explicit.sock');
    assert.throws(() => m.localSocketPath('', '../escape', env));
  });
});

describe('fonts', () => {
  it('parses CSS font stacks', () => {
    assert.deepEqual(m.fontStack(`'Droid Sans Mono', "Fira Code", monospace`), ['Droid Sans Mono', 'Fira Code', 'monospace']);
    assert.equal(m.cellHeight(14, 1), 20);
  });

  it('passes the stack to the browser: first family, then the rest and herdr.fontFallbacks', () => {
    const fonts = m.resolveFonts({ fontFamily: `'Sarasa Term SC', "Fira Code", monospace`, fontSize: 16, lineHeight: 1.2, fallbacks: ['Noto Sans CJK SC', 'Fira Code'] });
    assert.deepEqual(fonts, { family: 'Sarasa Term SC', fallbacks: ['Fira Code', 'Noto Sans CJK SC'], fontSize: 16, cellHeight: 27 });
  });

  it('leaves generic families to the browser', () => {
    // Quoted, `monospace` would name a font; herdr-web ends every stack with the generic.
    assert.deepEqual(m.resolveFonts({ fontFamily: `'Droid Sans Mono', 'monospace', monospace`, fontSize: 14, lineHeight: 1, fallbacks: [] }).fallbacks, []);
    assert.equal(m.resolveFonts({ fontFamily: 'monospace', fontSize: 14, lineHeight: 1, fallbacks: [] }).family, 'monospace');
  });
});

describe('links', () => {
  it('splits :line[:col] suffixes and resolves paths', () => {
    assert.deepEqual(m.splitLocation('src/a.rs:12:5'), { file: 'src/a.rs', line: 12, column: 5 });
    assert.deepEqual(m.splitLocation('README.md:3'), { file: 'README.md', line: 3, column: undefined });
    assert.deepEqual(m.splitLocation('/tmp/x'), { file: '/tmp/x' });
    assert.equal(m.resolvePath('~/notes.txt', '/w', '/home/u'), '/home/u/notes.txt');
    assert.equal(m.resolvePath('a/b', '/w', '/home/u'), '/w/a/b');
    assert.equal(m.resolvePath('/abs/../x', '/w', '/home/u'), '/x');
  });

  it('turns a printed path into a suffix search, aliases and module paths included', () => {
    assert.equal(m.searchSuffix('./src/store.ts'), 'src/store.ts');
    assert.equal(m.searchSuffix('@/data/vehicles'), 'data/vehicles');
    for (const unsearchable of ['/abs/a.ts', '~/a.ts', '../up/a.ts', 'a/./b.ts']) assert.equal(m.searchSuffix(unsearchable), undefined, unsearchable);
    assert.equal(m.suffixPattern('src/store.ts'), '**/src/store.ts');
    assert.equal(m.suffixPattern('data/vehicles'), '**/{data/vehicles,data/vehicles.*,data/vehicles/index.*}');
    // Glob syntax in names is matched loosely, then exactly.
    assert.equal(m.suffixPattern('app/[id]/page.tsx'), '**/app/?id?/page.tsx');
    assert.ok(m.matchesSuffix('/p/app/[id]/page.tsx', 'app/[id]/page.tsx'));
    assert.ok(!m.matchesSuffix('/p/app/xidx/page.tsx', 'app/[id]/page.tsx'));
    assert.ok(m.matchesSuffix('/p/src/data/vehicles.ts', 'data/vehicles'));
    assert.ok(m.matchesSuffix('/p/src/data/vehicles/index.tsx', 'data/vehicles'));
    assert.ok(!m.matchesSuffix('/p/src/data/vehiclesData.json', 'data/vehicles'));
    assert.ok(!m.matchesSuffix('/p/mysrc/store.ts', 'src/store.ts'));
  });

  it('finds a path printed relative to a subdirectory of the pane cwd, nearest first', async () => {
    const root = join(work, 'project');
    for (const file of ['v2/src/api/activity.ts', 'v2/src/data/vehicles.ts', 'v2/src/store.ts', 'old/deep/src/store.ts', 'node_modules/x/src/store.ts', 'README.md']) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), '');
    }
    // Stands in for VS Code's file search, which skips node_modules.
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.name === 'node_modules' ? [] : entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    const search = async (base) => walk(base);
    assert.deepEqual(await m.findPathLink('README.md', root, [], search), [join(root, 'README.md')]);
    assert.deepEqual(await m.findPathLink('src/api/activity.ts', root, [], search), [join(root, 'v2/src/api/activity.ts')]);
    assert.deepEqual(await m.findPathLink('@/data/vehicles', root, [], search), [join(root, 'v2/src/data/vehicles.ts')]);
    assert.deepEqual(await m.findPathLink('src/store.ts', root, [], search), [join(root, 'v2/src/store.ts'), join(root, 'old/deep/src/store.ts')]);
    // A workspace folder is tried directly too, and searched once with an enclosing cwd.
    assert.deepEqual(await m.findPathLink('api/activity.ts', '/nowhere', [join(root, 'v2/src')], search), [join(root, 'v2/src/api/activity.ts')]);
    assert.deepEqual(await m.findPathLink('src/none.ts', root, [join(root, 'v2')], search), []);
    assert.deepEqual(await m.findPathLink('../escape.ts', root, [], search), []);
  });

  it('opens files in the main editor group, beside a terminal that is that group', () => {
    assert.equal(m.pathColumn('follow', 2), 1);
    assert.equal(m.pathColumn('follow', undefined), 1);
    assert.equal(m.pathColumn('follow', 1), -2);
    assert.equal(m.pathColumn('side', 2), -2);
  });

  it('recognizes localhost addresses', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '[::1]', '0.0.0.0']) assert.ok(m.isLocalhost(host), host);
    for (const host of ['example.com', '128.0.0.1', 'localhost.example.com']) assert.ok(!m.isLocalhost(host), host);
  });
});

describe('colors', () => {
  const close = (actual, expected, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);
  const sample = {
    name: 'sample',
    background: '#1e1e2e',
    foreground: '#9a9cb0',
    cursor: '#f5e0dc',
    selection: '#45475a',
    palette: ['#45475a', '#a03040', '#2f6f2f', '#7a6a20', '#1010c0', '#803080', '#206868', '#7f849c', '#3a3c4e', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'],
  };

  it('converts to OKLab and measures APCA and WCAG contrast', () => {
    const white = m.rgbToOklab([1, 1, 1]);
    close(white.L, 1);
    close(white.a, 0);
    const red = m.rgbToOklab(m.parseColor('#ff0000'));
    close(red.L, 0.62796, 1e-4);
    close(red.a, 0.22486, 1e-4);
    close(red.b, 0.12585, 1e-4);
    for (const hex of ['#123456', '#fedcba', '#00ff7f', '#808080']) assert.equal(m.toHex(m.oklchToRgb(m.rgbToOklch(m.parseColor(hex)))), hex);
    close(m.apcaLc([0, 0, 0], [1, 1, 1]), 106.04, 0.01);
    close(m.apcaLc([1, 1, 1], [0, 0, 0]), -107.88, 0.01);
    close(m.wcagRatio([0, 0, 0], [1, 1, 1]), 21, 1e-9);
    // Out-of-gamut OKLCH keeps lightness and hue, giving up chroma.
    const mapped = m.rgbToOklch(m.oklchToRgb({ L: 0.9, C: 0.4, h: 264 }));
    close(mapped.L, 0.9, 2e-3);
    assert.ok(m.hueDistance(mapped.h, 264) < 1.5, `hue ${mapped.h}`);
  });

  it('reads and writes every scheme format', () => {
    const scheme = { ...sample, name: 'x' };
    const files = { konsole: 'x.colorscheme', iterm: 'x.itermcolors', windowsTerminal: 'x.json', ghostty: 'x', alacritty: 'x.toml', kitty: 'x.conf', vscode: 'x.json', xresources: 'x.Xresources' };
    for (const [format, file] of Object.entries(files)) {
      const [parsed] = m.parseSchemes(m.writeScheme(scheme, format), file);
      assert.ok(parsed, format);
      assert.deepEqual([parsed.background, parsed.foreground, ...parsed.palette], [scheme.background, scheme.foreground, ...scheme.palette], format);
    }
  });

  it('imports a Konsole scheme by its file name, intense colors as bright', () => {
    const text = ['[General]', 'Description=Paletty', '[Background]', 'Color=255,255,255', '[Foreground]', 'Color=0,0,0']
      .concat(Array.from({ length: 8 }, (_, i) => [`[Color${i}]`, `Color=${i * 10},0,0`, `[Color${i}Intense]`, `Color=${i * 10},5,0`]).flat())
      .join('\n');
    const [scheme] = m.parseSchemes(text, '/home/u/.local/share/konsole/light_optimized.colorscheme');
    assert.equal(scheme.name, 'light_optimized');
    assert.equal(scheme.source, 'Konsole: light_optimized');
    assert.equal(scheme.palette[3], '#1e0000');
    assert.equal(scheme.palette[11], '#1e0500');
  });

  it('optimizes only what falls short, by lightness alone, never the background', () => {
    const { scheme, changes } = m.optimize({ ...sample, locked: ['1'] }, 'standard');
    assert.equal(scheme.background, sample.background);
    for (const change of changes) {
      if (change.locked) {
        assert.equal(change.color, change.before, change.label);
        continue;
      }
      if (Math.abs(change.lcBefore) >= change.target) assert.equal(change.color, change.before, `${change.label} already passed`);
      if (change.target) assert.ok(change.pass, `${change.label}: Lc ${change.lc.toFixed(1)} < ${change.target}`);
      const [was, now] = [m.rgbToOklch(m.parseColor(change.before)), m.rgbToOklch(m.parseColor(change.color))];
      if (was.C > 0.03 && change.deltaE > 0) assert.ok(m.hueDistance(was.h, now.h) < 3, `${change.label} hue ${was.h.toFixed(1)} → ${now.h.toFixed(1)}`);
    }
    // Saturated blue on a dark background reads poorly however light it looks in OKLab.
    const blue = changes.find((change) => change.slot === '4');
    assert.ok(blue.deltaE > 0.1 && Math.abs(blue.lcBefore) < 30, JSON.stringify(blue));
    // Black is a background tint on a dark scheme: no target.
    assert.equal(changes.find((change) => change.slot === '0').target, 0);
    assert.deepEqual(m.optimize(scheme, 'standard').scheme.palette, scheme.palette, 'optimizing twice changes nothing more');
  });
});

describe('machines', () => {
  it('reads herdr.machines: valid targets once each, named after their host', () => {
    const machines = m.parseMachines([
      { target: 'dev@devbox' },
      { name: 'Loopback', target: 'ssh://dev@127.0.0.1:2222', session: 'e2e' },
      { target: 'dev@devbox', session: 'default', name: 'duplicate' },
      { target: '-oProxyCommand=x' },
      { target: 'host', session: '../escape' },
      'not an object',
    ]);
    assert.deepEqual(machines, [
      { name: 'devbox', target: 'dev@devbox', session: 'default' },
      { name: 'Loopback', target: 'ssh://dev@127.0.0.1:2222', session: 'e2e' },
    ]);
    assert.equal(m.defaultName('ssh://me@[::1]:22'), '::1');
    assert.equal(m.defaultName('alias'), 'alias');
    assert.notEqual(m.machineId('host', 'a'), m.machineId('host', 'b'));
  });

  it("explains ssh's failures", () => {
    assert.match(m.sshHint('h', 'Host key verification failed.'), /ssh h.*host key/);
    assert.match(m.sshHint('h', 'dev@h: Permission denied (publickey).'), /key/);
    assert.match(m.sshHint('h', 'ssh: connect to host h port 22: Connection refused'), /sshd/);
    assert.match(m.sshHint('h', 'ssh: Could not resolve hostname h: Name or service not known'), /host name/);
    assert.equal(m.sshHint('h', 'something else'), undefined);
  });

  it('probes a machine: logs in, finds herdr, checks its client protocol', async () => {
    const bin = join(work, 'probe-bin');
    const remoteBin = join(work, 'probe-remote', '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(remoteBin, { recursive: true });
    const status = JSON.stringify({ version: '9.9.9', binary: `${remoteBin}/herdr`, endpoint_protocol_generation: 1, endpoint_capabilities: ['surface_interest', 'presentation_effects_fence', 'health_check'] });
    writeFileSync(join(remoteBin, 'herdr'), `#!/bin/sh\n[ "$1 $2 $3" = "status client --json" ] && printf '%s\\n' '${status}'\n`);
    chmodSync(join(remoteBin, 'herdr'), 0o755);
    // A stand-in ssh: runs the remote command here, with the remote HOME; or fails like ssh.
    writeFileSync(
      join(bin, 'ssh'),
      `#!/bin/sh\ncase " $* " in *" badkey "*) echo 'Host key verification failed.' >&2; exit 255;; esac\nfor last; do :; done\nHOME=${join(work, 'probe-remote')} PATH=/usr/bin:/bin exec /bin/sh -c "$last"\n`,
    );
    chmodSync(join(bin, 'ssh'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const ok = await m.probeSsh('dev@goodhost');
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.match(ok.detail, /herdr 9\.9\.9/);
      const bad = await m.probeSsh('badkey');
      assert.equal(bad.ok, false);
      assert.match(bad.detail, /ssh to badkey failed: Host key verification failed/);
      assert.match(bad.hint, /host key/);
      writeFileSync(join(remoteBin, 'herdr'), '#!/bin/sh\nexit 1\n');
      const missing = await m.probeSsh('dev@goodhost');
      assert.equal(missing.ok, false);
      assert.match(missing.detail, /no herdr found/);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('ssh transport', () => {
  it('validates targets like herdr-gpui', () => {
    assert.ok(m.validSshTarget('user@host'));
    assert.ok(m.validSshTarget('ssh://user@host:2222'));
    assert.ok(!m.validSshTarget('-oProxyCommand=x'));
    assert.ok(!m.validSshTarget('user:pw@host'));
    assert.ok(!m.validSshTarget('a\nb'));
  });

  it('builds the bridge command, multiplexed over one private ControlMaster', () => {
    const args = m.sshArgs('host', "it's");
    assert.deepEqual(args.slice(-3, -1), ['--', 'host']);
    assert.match(args.at(-1), /^\/bin\/sh -c '/);
    assert.ok(args.includes('BatchMode=yes'));
    assert.ok(args.includes('ControlMaster=auto'));
    assert.ok(args.some((a) => /^ControlPath=.*herdr-ssh-\d+\/%C$/.test(a)));
    assert.ok(args.includes('ControlPersist=60'));
  });

  it('skips an incompatible candidate, accepts the next, then relays bytes', async () => {
    // A fake `ssh` that runs the bridge protocol locally: two candidates, then cat.
    const bin = join(work, 'bin');
    const status = (gen) => JSON.stringify({ endpoint_protocol_generation: gen, endpoint_capabilities: ['surface_interest', 'presentation_effects_fence', 'health_check'] });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'ssh'),
      `#!/bin/sh
printf '%s\\n\\nherdr-remote-output-ready:1\\n' '${status(0)}'
read -r choice; [ "$choice" = skip ] || exit 3
printf '%s\\n\\nherdr-remote-output-ready:1\\n' '${status(1)}'
read -r choice; [ "$choice" = accept ] || exit 4
exec cat
`,
    );
    chmodSync(join(bin, 'ssh'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const received = [];
      const result = await new Promise((resolve) => {
        let link;
        link = m.openLink(
          { kind: 'ssh', target: 'host', session: 'default' },
          {
            open: () => link.write(new TextEncoder().encode('ping')),
            data: (chunk) => {
              received.push(Buffer.from(chunk).toString());
              if (received.join('') === 'ping') link.close();
            },
            close: (reason) => resolve(reason),
          },
        );
      });
      assert.equal(received.join(''), 'ping');
      assert.match(result, /remote bridge exited/);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('api', () => {
  it('finds the JSON API socket next to the client socket', () => {
    assert.equal(m.apiSocketPath('/c/herdr/sessions/s/herdr-client.sock', {}), '/c/herdr/sessions/s/herdr.sock');
    assert.equal(m.apiSocketPath('/x/odd.sock', {}), '/x/herdr.sock');
    assert.equal(m.apiSocketPath('/x/herdr-client.sock', { HERDR_SOCKET_PATH: '/api.sock' }), '/api.sock');
  });

  it('runs the remote API bridge for the session and speaks JSON lines over its stdio', async () => {
    // A stand-in `herdr` on PATH: answers one request when run as the bridge of
    // the session it was asked for, the way `herdr remote-api-bridge` does.
    const bin = join(work, 'bin');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'herdr');
    writeFileSync(
      fake,
      `#!${process.execPath}
const [flag, session, mode] = process.argv.slice(2);
if (flag !== '--session' || mode !== 'remote-api-bridge') { console.error('bad args', process.argv.slice(2)); process.exit(2); }
process.stdin.once('data', (d) => {
  const req = JSON.parse(String(d));
  process.stdout.write(JSON.stringify({ id: req.id, result: { session, method: req.method, params: req.params } }) + '\\n');
});
`,
    );
    chmodSync(fake, 0o755);
    const { spawn } = await import('node:child_process');
    const child = spawn('/bin/sh', ['-c', m.apiBridgeCommand("it's mine")], {
      stdio: 'pipe',
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: work },
    });
    const result = await m.stdioRequest(child, 'pane.move', { pane_id: 'w1:p1', destination: { type: 'new_tab' } });
    assert.deepEqual(result, { session: "it's mine", method: 'pane.move', params: { pane_id: 'w1:p1', destination: { type: 'new_tab' } } });
  });

  it('reports a bridge that exits without answering', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn('/bin/sh', ['-c', 'echo herdr not found >&2; exit 127'], { stdio: 'pipe' });
    await assert.rejects(m.stdioRequest(child, 'tab.create', {}), /bridge exited \(127\).*herdr not found/);
  });

  it('round-trips a request over a JSON-lines socket', async () => {
    const socket = join(work, 'a.sock');
    const server = net.createServer((c) =>
      c.on('data', (d) => {
        const req = JSON.parse(String(d));
        c.end(JSON.stringify(req.method === 'ok' ? { id: req.id, result: { echo: req.params } } : { id: req.id, error: { code: 'nope', message: 'refused' } }) + '\n');
      }),
    );
    await new Promise((r) => server.listen(socket, r));
    const client = socket.replace(/a\.sock$/, 'a-client.sock');
    assert.deepEqual(await m.request({ kind: 'local', path: client }, 'ok', { x: 1 }), { echo: { x: 1 } });
    await assert.rejects(m.request({ kind: 'local', path: client }, 'bad', {}), /refused/);
    server.close();
  });
});

describe('model', () => {
  it('titles panes by label, agent, then cwd', () => {
    const pane = { pane_id: 'w1:p1', label: null, cwd: '/a/proj', foreground_cwd: '/a/proj/sub' };
    assert.equal(m.paneTitle(pane, undefined), 'sub');
    assert.equal(m.paneTitle({ ...pane, label: 'build' }, { display_agent: 'Claude' }), 'build');
    assert.equal(m.paneTitle(pane, { name: null, display_agent: 'Claude Code', agent: 'claude' }), 'Claude Code');
  });
});

describe('connection', () => {
  it('reconnects after the daemon goes away', async () => {
    const socket = join(work, 'd.sock');
    const events = [];
    const accepted = [];
    let server = net.createServer((c) => {
      accepted.push(c);
      c.write('hello');
    });
    await new Promise((r) => server.listen(socket, r));
    const connection = new m.Connection(() => ({ kind: 'local', path: socket }), {
      open: () => events.push('open'),
      data: (d) => events.push(`data:${Buffer.from(d)}`),
      closed: (reason) => events.push(`closed:${reason}`),
    });
    const waitFor = async (predicate) => {
      for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(predicate(), events.join(' | '));
    };
    connection.start();
    await waitFor(() => events.includes('data:hello'));
    // The daemon goes away, then comes back on the same path.
    server.close();
    for (const c of accepted) c.destroy();
    await new Promise((r) => setTimeout(r, 700));
    server = net.createServer((c) => c.write('again'));
    await new Promise((r) => server.listen(socket, r));
    await waitFor(() => events.filter((e) => e === 'open').length === 2 && events.includes('data:again'));
    assert.ok(events.some((e) => e.startsWith('closed:')));
    connection.stop();
    server.close();
  });
});
