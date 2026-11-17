// plugins/<name>/src/{manifest,worker}.mjs を dist/ に 1 本ずつ詰める（SDK も中に入れ、実行時の依存を無くす）。
// src/ui.mjs があれば dist/ui/index.js に詰める（React と SDK の UI は本体が渡すので外に出す）。
// 使い方: node plugins/build.mjs <name>   （dist は commit しない・image の build の plugins の段で作る）
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
const name = process.argv[2];
if (!name) { console.error('使い方: node plugins/build.mjs <name>'); process.exit(2); }
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), name);
for (const entry of ['manifest', 'worker']) {
  await build({ entryPoints: [path.join(dir, 'src', `${entry}.mjs`)], outfile: path.join(dir, 'dist', `${entry}.js`), bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'warning' });
}
const ui = path.join(dir, 'src', 'ui.mjs');
if (existsSync(ui)) {
  await build({ entryPoints: [ui], outfile: path.join(dir, 'dist', 'ui', 'index.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', legalComments: 'none', logLevel: 'warning',
    external: ['react', 'react-dom', 'react/jsx-runtime', '@paperclipai/plugin-sdk/ui', '@paperclipai/plugin-sdk/ui/hooks'] });
}
console.log(`built ${name}/dist`);
