// Copies the WASM builds into media/:
//   herdr-web  (wasm-bindgen --target web)    → media/herdr-web   the pane view, in each webview
//   herdr-core (wasm-bindgen --target nodejs) → media/herdr-core  the session model, in the extension host
// Usage: npm run sync-web [-- --web <pkg dir>] [-- --core <pkg dir>]
//        (defaults: ../spike/herdr-web/pkg and ../spike/herdr-core/pkg)
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const packages = [
  { name: 'herdr-web', from: arg('--web') ?? join(root, '../spike/herdr-web/pkg'), files: ['herdr_web.js', 'herdr_web_bg.wasm'] },
  { name: 'herdr-core', from: arg('--core') ?? join(root, '../spike/herdr-core/pkg'), files: ['herdr_core.js', 'herdr_core_bg.wasm'] },
];

for (const pkg of packages) {
  const target = join(root, 'media', pkg.name);
  mkdirSync(target, { recursive: true });
  for (const file of [...pkg.files, dts(pkg.name)]) {
    const from = join(resolve(pkg.from), file);
    if (!existsSync(from)) {
      if (file.endsWith('.d.ts')) continue;
      console.error(`sync-web: missing ${from}; build ${pkg.name} first`);
      process.exit(1);
    }
    copyFileSync(from, join(target, file));
    console.log(`sync-web: ${pkg.name}/${file} (${(statSync(from).size / 1048576).toFixed(1)} MB)`);
  }
}

function dts(name) {
  return `${name.replace('-', '_')}.d.ts`;
}
