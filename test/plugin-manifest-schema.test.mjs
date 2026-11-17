// plugin の manifest を本体（Paperclip）の schema で確かめる（本体は入れる時にこの schema で断る）
// 図書室 0.2.0 の routeKey に大文字（askAnswer）があり、container で plugin が failed になったのを unit で見逃した（2026-11-17・写しの CI）
// plugin は plugins/*/src/manifest.mjs から集める（手で並べると、足した plugin が試験の外に漏れる・独立レビュー P3-2）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pluginManifestV1Schema } from '@paperclipai/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const found = fs.readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(root, 'plugins', d.name, 'src', 'manifest.mjs')))
  .map(d => d.name);

test('plugin の manifest を全部集めた', () => {
  assert.ok(found.length >= 5, `見つかった plugin: ${found.join(', ')}`);
});

for (const name of found) {
  test(`${name} の manifest は本体の schema を通る`, async () => {
    const m = (await import(pathToFileURL(path.join(root, 'plugins', name, 'src', 'manifest.mjs')).href)).default;
    const r = pluginManifestV1Schema.safeParse(m);
    assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues.map(i => [i.path.join('.'), i.message])));
  });
}

// 確かめに使う schema の版が image の本体の版と同じ（版がずれると、手元で通っても container で断られる・独立レビュー P3-3）
test('schema の版（@paperclipai/shared）が image の本体（runtime の paperclipai）の版と同じ', () => {
  const shared = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@paperclipai/shared/package.json'), 'utf8')).version; // exports の外なので file を読む
  const runtime = JSON.parse(fs.readFileSync(path.join(root, 'packages/aioffice/runtime/package.json'), 'utf8')).dependencies.paperclipai;
  assert.equal(shared, runtime);
});
