// 今ある office の移し替え（設計 docs/design/2026-11-23-public-office-multi-user.md 2.4）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaimWatcher, parseBackup, backupDone, migrationStep } from '../packages/aioffice/launcher/lib/migrate.mjs';

test('本体の出力から claim の URL を拾い、その行はログに写さない（色の符号・行の途中の切れ目も）', () => {
  const out = []; const w = createClaimWatcher(l => out.push(l));
  w.feed('server listening\n\x1b[36mBOARD CLAIM\x1b[0m http://localhost:3100/board-claim/');
  w.feed('tok_ABCdef123456?code=XyZ987654321\nnext line\n');
  assert.deepEqual(w.current() && { token: w.current().token, code: w.current().code }, { token: 'tok_ABCdef123456', code: 'XyZ987654321' });
  assert.ok(!out.join('').includes('tok_ABCdef123456'), 'token をログに写さない');
  assert.ok(!out.join('').includes('XyZ987654321'), 'code をログに写さない');
  assert.ok(out.includes('server listening\n') && out.includes('next line\n'));
  w.clear(); assert.equal(w.current(), null);
});

test('改行の無い長い出力に claim の URL があっても写さない', () => {
  const out = []; const w = createClaimWatcher(l => out.push(l));
  w.feed('x'.repeat(70 * 1024) + ' http://localhost:3100/board-claim/tok_LONG123456789?code=CODE987654321 ' + 'y'.repeat(1000));
  w.feed('z'.repeat(70 * 1024)); w.feed('\n');
  assert.ok(!out.join('').includes('tok_LONG123456789'), 'token を写さない');
  assert.ok(!out.join('').includes('CODE987654321'), 'code を写さない');
  assert.equal(w.current()?.token, 'tok_LONG123456789');
});

test('backup の印は --json の backupFile と sizeBytes だけ・途中の file は数えない', () => {
  assert.deepEqual(parseBackup('Backing up...\n{"backupFile":"/data/paperclip/b/aioffice-before-auth-1.sql.gz","sizeBytes":1234}\n'), { backupFile: '/data/paperclip/b/aioffice-before-auth-1.sql.gz', sizeBytes: 1234 });
  assert.deepEqual(parseBackup('{\n  "backupFile": "/x.sql.gz",\n  "sizeBytes": 9\n}\n'), { backupFile: '/x.sql.gz', sizeBytes: 9 });
  assert.equal(parseBackup('done: /x.sql.gz (1234 bytes)'), null, '人向けの出力は拾わない');
  assert.equal(parseBackup('{"backupFile":"/x","sizeBytes":0}'), null);
  const stat = sizes => p => { if (!(p in sizes)) throw new Error('ENOENT'); return { size: sizes[p] }; };
  assert.equal(backupDone({ backupFile: '/x', sizeBytes: 9 }, stat({ '/x': 9 })), true);
  assert.equal(backupDone({ backupFile: '/x', sizeBytes: 9 }, stat({ '/x': 5 })), false, '大きさが違う');
  assert.equal(backupDone({ backupFile: '/x', sizeBytes: 9 }, stat({})), false, 'file が無い');
  assert.equal(backupDone(null, stat({ '/x': 9 })), false, '印が無い（途中で止まった file があっても）');
});

test('段は上から順に事実で決める: 鍵 → session の admin → backup → token', () => {
  assert.equal(migrationStep({ hasKey: true, sessionAdmin: false, backupOk: false, claim: null }), 'finish');
  assert.equal(migrationStep({ hasKey: false, sessionAdmin: true, backupOk: false, claim: null }), 'key');
  assert.equal(migrationStep({ hasKey: false, sessionAdmin: false, backupOk: false, claim: { token: 't' } }), 'backup', 'backup の前に claim へ進まない');
  assert.equal(migrationStep({ hasKey: false, sessionAdmin: false, backupOk: true, claim: { token: 't' } }), 'claim');
  assert.equal(migrationStep({ hasKey: false, sessionAdmin: false, backupOk: true, claim: null }), 'lost');
});

test('改行の無い長い出力で、claim の URL が切る所をまたいでも、頭も途中の code も写さず、全部を拾う（2 回目のレビュー 低 7）', async () => {
  const { createClaimWatcher } = await import('../packages/aioffice/launcher/lib/migrate.mjs');
  const tok = 'T'.repeat(40), code = 'CODE1234ABCD', url = `/board-claim/${tok}?code=${code}`;
  // 1 回目の塊の終わりから 512 字手前が切る所。URL の後ろの長さ tail を 512 - URL の長さ から 512 まで動かすと、URL が切る所をまたぐ
  for (let tail = 512 - url.length - 5; tail <= 520; tail += 3) {
    let out = ''; const w = createClaimWatcher(x => { out += x; });
    w.feed('x'.repeat(64 * 1024) + url + ' ' + 'y'.repeat(tail - 1)); w.feed('z'.repeat(64 * 1024)); w.feed('\n');
    const off = tail;
    assert.ok(!out.includes(tok) && !out.includes(code) && !/board-claim\/[A-Za-z0-9]/.test(out), `写した ${off}`);
    assert.deepEqual([w.current()?.token, w.current()?.code], [tok, code], `拾った ${off}`);
  }
});

test('URL の形でない行（本体の要求のログ・JSON）にも claim の token と code を写さない・拾った値はどの行でも伏せる・ほかの code は残す（2026-11-24 e2e）', async () => {
  const { createClaimWatcher } = await import('../packages/aioffice/launcher/lib/migrate.mjs');
  const tok = 'a1'.repeat(24), code = 'b2'.repeat(12);
  let out = ''; const w = createClaimWatcher(x => { out += x; });
  w.feed(`\x1b[33mhttp://localhost:3101/board-claim/${tok}?code=${code}\x1b[0m\n`);
  w.feed(`{"level":30,"req":{"method":"POST","url":"/api/board-claim/${tok}/claim"},"msg":"request completed"}\n`);
  w.feed(`[17:38:26] \x1b[32mINFO\x1b[39m: \x1b[36mGET /board-claim/${tok} 200\x1b[39m\n`); // 2026-11-24 の e2e で docker logs に出た形（claim の画面を開いた要求のログ）
  w.feed(`GET /api/board-claim/${tok} 200\n{"challenge":{"code":"${code}"}}\nsaw ${tok} and ${code}\n{"err":{"code":"ECONNREFUSED"}}\n`);
  assert.ok(!out.includes(tok) && !out.includes(code), out);
  assert.match(out, /ECONNREFUSED/, 'ほかの code は伏せない');
  assert.deepEqual([w.current().token, w.current().code], [tok, code]);
});
