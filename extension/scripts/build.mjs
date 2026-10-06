// Bundles the extension host (Node, CommonJS) and the webview script (browser, ESM).
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const watch = process.argv.includes('--watch');
const common = { absWorkingDir: root, bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };
const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'esm',
  },
  {
    ...common,
    entryPoints: ['src/webview/settings.ts'],
    outfile: 'dist/settings.js',
    platform: 'browser',
    format: 'esm',
  },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
