// Two client-shell connections, each focusing a different herdr tab through its own
// endpoint request: does each receive its own tab's surface (per-client location)?
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Core } = require('./herdr-core/pkg/herdr_core.js');
const SOCKET = process.argv[2];

function client(name, cols) {
  const core = new Core();
  const sock = net.connect(SOCKET);
  const state = { name, core, sock, surfaces: 0, panes: [] };
  sock.on('data', (chunk) => {
    const events = JSON.parse(core.feed(chunk));
    for (const e of events) if (e.type === 'surface') state.surfaces++;
    let frame;
    while ((frame = core.next_request())) sock.write(frame);
    const panes = JSON.parse(core.panes_json());
    if (panes.length) state.panes = panes.map((p) => `${p.pane_id}@${p.rect.width}x${p.rect.height}`);
  });
  sock.write(core.hello(cols, 20, 9, 18, true));
  state.focus = (tab) => {
    core.request_json('tab.focus', JSON.stringify({ tab_id: tab }));
    let frame;
    while ((frame = core.next_request())) sock.write(frame);
  };
  return state;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const a = client('A', 100), b = client('B', 70);
await wait(800);
a.focus('w1:t1');
await wait(300);
b.focus('w1:t2');
await wait(800);
console.log(`A (100 cols) shows: ${a.panes.join(', ')}   surfaces received: ${a.surfaces}`);
console.log(`B (70 cols)  shows: ${b.panes.join(', ')}   surfaces received: ${b.surfaces}`);
a.focus('w1:t2');
await wait(800);
console.log(`after A also focuses w1:t2 → A: ${a.panes.join(', ')}  B: ${b.panes.join(', ')}`);
a.sock.end(); b.sock.end();
