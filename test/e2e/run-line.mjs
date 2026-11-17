// RUN.txt から正式の行を読み出す（README・記事・CI が同じ行を使い、手で写さない）
// 使い方: node test/e2e/run-line.mjs <start|open|update|reset-owner> [版]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function runLine(section, version) {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/aioffice/RUN.txt');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const i = lines.findIndex(l => l.trim() === `[${section}]`);
  if (i < 0) throw new Error(`RUN.txt に [${section}] が無い`);
  const line = lines.slice(i + 1).find(l => l.trim() && !l.startsWith('#'));
  return version ? line.replaceAll('VERSION', version) : line;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(runLine(process.argv[2], process.argv[3]));
