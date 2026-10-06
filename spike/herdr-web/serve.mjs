// Serves the herdr-web page and bridges /ws to a herdr client socket (binary, both ways).
// Usage: node serve.mjs <herdr-client.sock> [port]
// In VS Code this bridge is the extension host and the transport is postMessage.
import http from 'node:http';
import net from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { WebSocketServer } from 'ws';

const SOCKET = process.argv[2];
const PORT = Number(process.argv[3] || 0);
const ROOT = new URL('.', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
// The terminal family and its fallbacks, as VS Code would resolve them from
// terminal.integrated.fontFamily; served by index so the page can fetch bytes.
// An empty FONT_FILES sends no bytes: the page draws with the browser's fonts.
const FONTS = process.env.FONT_FILES !== undefined ? {
  family: process.env.FONT_FAMILY ?? 'monospace',
  fallbacks: (process.env.FONT_FALLBACKS ?? '').split(',').filter(Boolean),
  files: process.env.FONT_FILES.split(',').filter(Boolean),
} : {
  family: 'JetBrains Mono',
  fallbacks: ['Noto Sans CJK SC'],
  files: [
    '/usr/local/share/fonts/JetBrainsMono/JetBrainsMono-Regular.ttf',
    '/usr/local/share/fonts/JetBrainsMono/JetBrainsMono-Bold.ttf',
    '/usr/local/share/fonts/JetBrainsMono/JetBrainsMono-Italic.ttf',
    '/usr/local/share/fonts/JetBrainsMono/JetBrainsMono-BoldItalic.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  ],
};

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/fonts.json') {
    const body = { ...FONTS, files: FONTS.files.map((_, i) => `/font/${i}`) };
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }
  const font = path.match(/^\/font\/(\d+)$/);
  if (font && FONTS.files[Number(font[1])]) {
    return res.writeHead(200, { 'content-type': 'font/ttf' }).end(readFileSync(FONTS.files[Number(font[1])]));
  }
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  if (!file.startsWith(ROOT) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
});

new WebSocketServer({ server, path: '/ws' }).on('connection', (ws) => {
  const daemon = net.connect(SOCKET);
  daemon.setNoDelay?.(true);
  daemon.on('data', (chunk) => ws.send(chunk, { binary: true }));
  daemon.on('close', () => ws.close(1000, 'daemon closed'));
  daemon.on('error', (error) => ws.close(1011, error.message));
  ws.on('message', (data) => daemon.write(data));
  ws.on('close', () => daemon.destroy());
});

server.listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/`));
