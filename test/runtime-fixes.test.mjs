// 本体の不具合の直し（packages/aioffice/runtime/fixes/apply.mjs）を、偽の node_modules に当てて確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APPLY = join(dirname(fileURLToPath(import.meta.url)), '../packages/aioffice/runtime/fixes/apply.mjs');
const ANCHOR = 'const policies = await Promise.all(rows.map((row) => buildPolicySummary(row)));';
const FILE = '@paperclipai/server/dist/services/budgets.js';

function fakeModules(body) {
  const root = mkdtempSync(join(tmpdir(), 'aio-fix-'));
  mkdirSync(join(root, dirname(FILE)), { recursive: true });
  writeFileSync(join(root, FILE), body);
  return root;
}
const run = root => spawnSync(process.execPath, [APPLY, root], { encoding: 'utf8' });

// 直した後の一覧の作り方を、本体と同じ形の関数で動かす
async function overviewWith(code, summary) {
  const fn = new Function('rows', 'buildPolicySummary', `return (async () => { ${code} return policies; })();`);
  return fn([{ id: 'a' }, { id: 'gone' }, { id: 'b' }], summary);
}
const notFound = () => Object.assign(new Error('Agent not found'), { status: 404 });

test('当てる所が 1 か所ならその行を直し、消えた担当の予算（404）だけを一覧から外す', async () => {
  const root = fakeModules(`x;\n        ${ANCHOR}\n        y;\n`);
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stderr);
    const out = readFileSync(join(root, FILE), 'utf8');
    assert.ok(!out.includes(ANCHOR));
    const line = out.split('\n').find(l => l.includes('const policies'));
    const got = await overviewWith(line, async row => { if (row.id === 'gone') throw notFound(); return row.id; });
    assert.deepEqual(got, ['a', 'b']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('404 でない失敗は、今までどおり一覧ごと投げる', async () => {
  const root = fakeModules(ANCHOR);
  try {
    assert.equal(run(root).status, 0);
    const line = readFileSync(join(root, FILE), 'utf8');
    await assert.rejects(overviewWith(line, async row => { if (row.id === 'gone') throw Object.assign(new Error('db down'), { status: 500 }); return row.id; }), /db down/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('当てる所が無い・2 か所ある時は build を落とす（版が上がって形が変わった時に気づく）', () => {
  for (const body of ['nothing here', `${ANCHOR}\n${ANCHOR}`]) {
    const root = fakeModules(body);
    try {
      const r = run(root);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /当てる所が [02] か所/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
