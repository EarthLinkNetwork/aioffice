// image の build に送る物は .dockerignore の許可の一覧（* で全部を外し、! で許す）で決まる。
// Dockerfile の COPY の元が一覧に無いと、build が「not found」で落ちる（2026-11-19 に runtime/fixes を足し忘れて CI の build が落ちた）。
// COPY の元（--from の段の写しを除く）が、どれも一覧の ! の行そのものか、その下にあることを確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = f => readFileSync(join(ROOT, f), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

export function allowedPaths(ignoreLines) {
  assert.equal(ignoreLines[0], '*', '.dockerignore は * で全部を外してから ! で許す形');
  return ignoreLines.filter(l => l.startsWith('!')).map(l => l.slice(1).replace(/\/+$/, ''));
}

export function copySources(dockerLines) {
  const out = [];
  for (const l of dockerLines) {
    if (!/^COPY\s/i.test(l) || /--from=/.test(l)) continue;
    const parts = l.split(/\s+/).slice(1).filter(p => !p.startsWith('--'));
    out.push(...parts.slice(0, -1)); // 最後は写し先
  }
  return out;
}

const covered = (src, allow) => allow.some(a => src === a || src.startsWith(a + '/'));

test('Dockerfile の COPY の元は、どれも .dockerignore で許されていて、repo にある', () => {
  const allow = allowedPaths(lines('.dockerignore'));
  const srcs = copySources(lines('packages/aioffice/Dockerfile'));
  assert.ok(srcs.length > 10, `COPY の元を読めていない（${srcs.length} 件）`);
  assert.deepEqual(srcs.filter(s => !covered(s, allow)), [], '.dockerignore の ! に足す');
  assert.deepEqual(srcs.filter(s => !existsSync(join(ROOT, s))), [], 'COPY の元が repo に無い');
});

test('判定の形: 一覧の下は許し、一覧に無い兄弟は断る', () => {
  const allow = allowedPaths(['*', '!packages/aioffice/runtime/stubs', '!plugins/office/']);
  assert.ok(covered('packages/aioffice/runtime/stubs', allow));
  assert.ok(covered('plugins/office/src/x.mjs', allow));
  assert.ok(!covered('packages/aioffice/runtime/fixes', allow));
  assert.ok(!covered('plugins/office2', allow));
  assert.deepEqual(copySources(['COPY --from=runtime /a /b', 'COPY a b /dst/', 'COPY --chown=1:1 c /d']), ['a', 'b', 'c']);
});
