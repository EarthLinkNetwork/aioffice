// image の build で、Paperclip の built-in の adapter の型と wizard の AI の表を突き合わせる
// 表に無い型があれば exit 1 で build を落とす（server の中で増えた型も拾う）。範囲: docs/review/2026-11-17-wizard-ai-choice-scope.md の作り方 7
import { pathToFileURL } from 'node:url';
import { AI_CATALOG } from './ai-catalog.mjs';

export const BUILTIN_TYPES_PATH = '/opt/aioffice/runtime/node_modules/@paperclipai/server/dist/adapters/builtin-adapter-types.js';

export function unknownTypes(builtinTypes) {
  const known = new Set(AI_CATALOG.map(e => e.type));
  return [...builtinTypes].filter(t => !known.has(t)).sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // package の exports は "." だけなので、絶対パスで読む
  const mod = await import(pathToFileURL(process.argv[2] || BUILTIN_TYPES_PATH).href);
  const types = mod.BUILTIN_ADAPTER_TYPES;
  if (!types || typeof types[Symbol.iterator] !== 'function') { console.error('BUILTIN_ADAPTER_TYPES を読めない'); process.exit(1); }
  const missing = unknownTypes(types);
  if (missing.length) { console.error(`wizard の AI の表に無い adapter: ${missing.join(', ')}（launcher/lib/ai-catalog.mjs に載せるか外す理由を書く）`); process.exit(1); }
  console.log(`adapter の型 ${[...types].length} 種は全部、wizard の AI の表にある`);
}
