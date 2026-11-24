// フォルダの欄（docs/review/2026-11-17-wizard-folder-scope.md）の試験: 絞り込みと分け方・起動係の口・部屋は部屋の会社へ
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, planFolder, toBatches, tally, utf8Bytes, FOLDER } from '../packages/aioffice/launcher/public/folder-pick.js';
import { docName } from '../plugins/library/src/lib.mjs';
import { createLauncher, FOLDER_LIMITS } from '../packages/aioffice/launcher/server.mjs';
import { createPaperclip, LIBRARY_PUT_MS } from '../packages/aioffice/launcher/lib/paperclip.mjs';
import { folderToLibrary } from '../plugins/office/src/api.mjs';
import { hashPassword, issueCookie } from '../packages/aioffice/launcher/lib/guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aio-folder-'));

test('名前は道を › でつなぐ・図書室の docName でも同じ名前のまま・別のフォルダの同じ file 名は別の名前（保証 1・B1）', () => {
  const a = classify('notes/a/README.md'), b = classify('notes/b/README.md');
  assert.equal(a.name, 'notes › a › README.md'); assert.notEqual(a.name, b.name);
  assert.equal(docName(a.name), a.name, '図書室は › の名前を切らない');
  assert.equal(classify('notes/x.TXT').name, 'notes › x.TXT', '拡張子は大文字小文字を問わない');
  assert.equal(classify('one.md').name, 'one.md', 'フォルダを持たない時（複数の file を選ぶ欄）は file の名前');
});

test('送らない物: .md・.txt 以外・隠し（選んだフォルダ自身は除く）・node_modules・長い名前・同じ名前（保証 2）', () => {
  assert.equal(classify('n/a.pdf').why, 'type');
  assert.equal(classify('n/.git/x.md').why, 'hidden');
  assert.equal(classify('n/sub/.notes.md').why, 'hidden');
  assert.equal(classify('n/node_modules/p/README.md').why, 'hidden');
  assert.equal(classify('.notes/a.md').name, '.notes › a.md', '選んだフォルダが . で始まっても中は送る（P3-3）');
  assert.equal(classify(`n/${'x'.repeat(200)}.md`).why, 'name');
  assert.equal(classify('n/a\\b.md').why, 'name', '\\ は図書室が道として切るので送らない');
  const plan = planFolder([['n/A.md'], ['n/a.md'], ['n/b.txt'], ['n/c.png'], ['n/.x/d.md'], ['n/node_modules/e.md']].map(([p]) => ({ path: p, file: p })));
  assert.deepEqual(plan.take.map(x => x.name), ['n › A.md', 'n › b.txt']);
  assert.deepEqual(plan.skipped, { type: 1, hidden: 2, name: 0, dup: 1, size: 0 });
});

test('束: 1 回 20 件・JSON で 2MB まで・200KB（UTF-8）を超える物は外す（P3-2）', () => {
  const docs = Array.from({ length: 45 }, (_, i) => ({ name: `d${i}.md`, text: 'x' }));
  assert.deepEqual(toBatches(docs).batches.map(b => b.length), [20, 20, 5]);
  const big = 'あ'.repeat(70 * 1024); // 文字数は 200K 未満でも UTF-8 で 210KB
  assert.ok(big.length < FOLDER.docBytes && utf8Bytes(big) > FOLDER.docBytes);
  assert.deepEqual(toBatches([{ name: 'big.md', text: big }, { name: 'ok.md', text: 'y' }]).tooBig, ['big.md']);
  const mid = 'y'.repeat(190 * 1024), many = Array.from({ length: 15 }, (_, i) => ({ name: `m${i}.md`, text: mid }));
  const bs = toBatches(many).batches;
  assert.ok(bs.length > 1 && bs.every(b => utf8Bytes(JSON.stringify(b)) <= FOLDER.batchBytes), '束は JSON で 2MB を超えない');
  assert.deepEqual(tally([{ ok: true }, { ok: false, why: 'library_doc_count' }, { ok: false, why: 'library_doc_count' }, { ok: false }]), { put: 1, refused: { library_doc_count: 2, library_failed: 1 } });
});

// 偽の本体: 図書室の文書の口だけ（会社は query）
function fakeLibrary({ holdMs = 0 } = {}) {
  const puts = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      if (req.method === 'POST' && u.pathname === '/api/plugins/aioffice.library/api/documents') {
        const body = JSON.parse(b); puts.push({ companyId: u.searchParams.get('companyId'), ctype: req.headers['content-type'], ...body });
        const out = body.name.includes('full') ? [400, { error: 'library_doc_count' }] : body.name.includes('boom') ? [500, { error: 'x' }] : [201, { name: body.name }];
        return setTimeout(() => { res.writeHead(out[0], { 'content-type': 'application/json' }); res.end(JSON.stringify(out[1])); }, holdMs);
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return { srv, puts };
}
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function req(port, method, p, { body, raw, cookie, ctype = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }; if (cookie) headers.cookie = cookie;
    const data = raw ?? (body == null ? null : JSON.stringify(body)); if (data != null) { headers['content-type'] = ctype; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* 文字 */ } resolve({ status: res.statusCode, json: j }); }); });
    r.on('error', reject); if (data != null) r.write(data); r.end(); // 接続が切れたら失敗にする（413 は本当の応答で確かめる・codex P2-1）
  });
}
async function launcher(status = 'ready', opts = {}) {
  const dir = tmp(), lib = fakeLibrary(opts), pcPort = await listen(lib.srv);
  let st = status;
  const { server, store } = createLauncher({ dataDir: path.join(dir, 'aioffice'), paperclipUrl: `http://127.0.0.1:${pcPort}`, codexHome: path.join(dir, 'codex-home'), pluginStatus: () => (st ? { 'aioffice.library': { status: st } } : {}) });
  store.update(s => { s.owner = hashPassword('long enough'); s.generation = 1; s.lang = 'en'; s.companyId = 'wiz'; s.secretaryId = 'a1'; });
  const port = await listen(server), cookie = `${issueCookie(store.secret, 1).split(';')[0]}`;
  return { port, cookie, lib, store, setStatus: v => { st = v; }, close: () => { server.close(); lib.srv.close(); } };
}

test('起動係の口: login が無ければ 401・JSON でなければ 415・20 件か 2MB を超えれば 413・図書室が pending なら 409（保証 3・5）', async () => {
  const L = await launcher('pending');
  try {
    const one = { docs: [{ name: 'n › a.md', text: 'hello' }] };
    assert.equal((await req(L.port, 'POST', '/setup/api/library/folder', { body: one })).status, 401);
    assert.equal((await req(L.port, 'POST', '/setup/api/library/folder', { raw: 'name=a', ctype: 'application/x-www-form-urlencoded', cookie: L.cookie })).status, 415);
    assert.equal((await req(L.port, 'POST', '/setup/api/library/folder', { body: one, cookie: L.cookie })).json.error, 'library_pending', '図書室が入る前は送らない');
    assert.equal(L.lib.puts.length, 0);
    L.setStatus('failed');
    assert.equal((await req(L.port, 'POST', '/setup/api/library/folder', { body: one, cookie: L.cookie })).json.error, 'library_unavailable');
    L.setStatus('ready');
    assert.equal((await req(L.port, 'POST', '/setup/api/library/folder', { body: { docs: Array.from({ length: 21 }, (_, i) => ({ name: `${i}.md`, text: 'x' })) }, cookie: L.cookie })).status, 413);
    const two = 'z'.repeat(1.1 * 1024 * 1024);
    assert.equal((await req(L.port, 'POST', '/setup/api/library/folder', { body: { docs: [{ name: 'a.md', text: two }, { name: 'b.md', text: two }] }, cookie: L.cookie })).status, 413, 'JSON で 2MB を超える');
    assert.equal((await req(L.port, 'POST', '/setup/api/library/folder', { body: { docs: [{ name: 'a.md', text: 'z'.repeat(3 * 1024 * 1024) }] }, cookie: L.cookie })).status, 413, '本文が 2.5MB を超える');
    assert.equal((await req(L.port, 'POST', '/setup/api/library/folder', { body: { docs: 'x' }, cookie: L.cookie })).json.error, 'bad_docs');
    assert.equal((await req(L.port, 'POST', '/setup/api/company', { body: { name: 'q'.repeat(20 * 1024) }, cookie: L.cookie })).status, 413, 'ほかの口の本文は 16KB のまま');
    assert.equal(L.lib.puts.length, 0);
  } finally { L.close(); }
});

test('起動係の口: wizard の会社の図書室へ 1 件ずつ JSON で渡し、本文の companyId は使わない・件ごとの結果を返す・同時の 2 本目は 409（保証 1・4・6・P3-4）', async () => {
  const L = await launcher('ready', { holdMs: 30 });
  try {
    const docs = [{ name: 'n › a › README.md', text: 'alpha' }, { name: 'n › b › README.md', text: 'beta' }, { name: 'n › full.md', text: 'c' }, { name: 'n › boom.md', text: 'd' }];
    const first = req(L.port, 'POST', '/setup/api/library/folder', { body: { docs, companyId: 'other' }, cookie: L.cookie });
    await new Promise(r => setTimeout(r, 10));
    assert.equal((await req(L.port, 'POST', '/setup/api/library/folder', { body: { docs: [docs[0]] }, cookie: L.cookie })).json.error, 'folder_busy');
    const r = await first;
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.results.map(x => [x.name, x.ok, x.why || null]), [['n › a › README.md', true, null], ['n › b › README.md', true, null], ['n › full.md', false, 'library_doc_count'], ['n › boom.md', false, 'library_failed']]);
    assert.deepEqual([...new Set(L.lib.puts.map(p => p.companyId))], ['wiz'], '宛先は wizard の会社だけ');
    assert.ok(L.lib.puts.every(p => /^application\/json/.test(p.ctype)));
    assert.deepEqual(L.lib.puts.map(p => p.name), docs.map(d => d.name), '順に 1 件ずつ');
  } finally { L.close(); }
});

test('段: agents の done で agentsDone が立ち、state に図書室の状態が出る・wizard は folder-pick.js を配る（保証 5・P3-a）', async () => {
  const L = await launcher('pending');
  try {
    let s = (await req(L.port, 'GET', '/setup/api/state', { cookie: L.cookie })).json;
    assert.deepEqual([s.agentsDone, s.library], [false, 'pending']);
    s = (await req(L.port, 'POST', '/setup/api/agents', { body: { ids: [], done: true }, cookie: L.cookie })).json;
    assert.equal(s.agentsDone, true); assert.equal(s.done, false, 'まだ完了ではない（フォルダの段で完了）');
    const js = await new Promise(res => http.get({ host: '127.0.0.1', port: L.port, path: '/setup/folder-pick.js', headers: { host: `127.0.0.1:${L.port}` } }, r => { let t = ''; r.on('data', c => { t += c; }); r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'], t })); }));
    assert.equal(js.status, 200); assert.match(js.type, /javascript/); assert.match(js.t, /export function planFolder/);
  } finally { L.close(); }
  const setup = fs.readFileSync(path.join(root, 'packages/aioffice/launcher/public/setup.js'), 'utf8');
  assert.match(setup, /s\.agentsDone \? 'folder'/, '読み込み直しても folder の段に戻る');
  assert.match(setup, /if \(!sending\) finish\(\)/, '送っている間は飛ばせない（P3-c）');
  assert.match(setup, /\/setup\/api\/library\/folder/);
});

test('部屋のフォルダ選びは部屋の会社の図書室の口（libraryPut）へ置き、起動係の口を使わない（保証 6・実装レビュー P3-5）', async () => {
  const calls = [], api = { libraryPut: async (c, name, text) => { calls.push([c, name, text]); if (name.includes('full')) throw Object.assign(new Error('x'), { body: { error: 'library_doc_count' } }); return { name }; } };
  const file = (p, text) => ({ webkitRelativePath: p, name: p.split('/').pop(), text: async () => text });
  const progress = [];
  const r = await folderToLibrary({ api, companyId: 'room2', files: [file('n/a/README.md', 'A'), file('n/b/README.md', 'B'), file('n/full.md', 'F'), file('n/x.png', 'P'), file('n/big.md', 'あ'.repeat(70 * 1024))], onProgress: p => progress.push(p) });
  assert.deepEqual(calls.map(c => c[0]), ['room2', 'room2', 'room2'], '宛先は部屋の会社');
  assert.deepEqual(calls.map(c => c[1]), ['n › a › README.md', 'n › b › README.md', 'n › full.md']);
  assert.deepEqual(r.done, { put: 2, refused: { library_doc_count: 1 } });
  assert.deepEqual(r.skipped, { type: 1, hidden: 0, name: 0, dup: 0, size: 1 });
  assert.deepEqual(progress, ['1 / 3', '2 / 3', '3 / 3']);
  const src = fs.readFileSync(path.join(root, 'plugins/office/src/panels.mjs'), 'utf8') + fs.readFileSync(path.join(root, 'plugins/office/src/api.mjs'), 'utf8');
  assert.match(src, /from '\.\.\/\.\.\/\.\.\/packages\/aioffice\/launcher\/public\/folder-pick\.js'/, '同じ純粋な関数を取り込む（写さない）');
  assert.doesNotMatch(src, /setup\/api\/library\/folder/);
  const docker = fs.readFileSync(path.join(root, 'packages/aioffice/Dockerfile'), 'utf8');
  assert.match(docker, /COPY packages\/aioffice\/launcher\/public\/folder-pick\.js \/src\/packages\/aioffice\/launcher\/public\/folder-pick\.js/, 'image の plugin の段でも取り込める');
});

test('本体の図書室の口は時間の上限つきで呼ぶ（止まっても folder の口を塞がない・実装レビュー P3-3）', async () => {
  let seen = null;
  const pc = createPaperclip({ base: 'http://127.0.0.1:1', fetchFn: async (u, o) => { seen = o.signal; throw new Error('aborted'); } });
  await assert.rejects(pc.libraryPut('c', 'a.md', 'x'), e => e.status === 503);
  assert.ok(seen instanceof AbortSignal, 'signal を付ける');
  assert.equal(LIBRARY_PUT_MS, 60_000);
  const setup = fs.readFileSync(path.join(root, 'packages/aioffice/launcher/public/setup.js'), 'utf8');
  assert.doesNotMatch(setup, /plan\.skipped\.size \+=/, 'やり直しで数が増えない（P3-1）');
  assert.match(setup, /data-folder-partial/, '途中で失敗しても置けた数を出す（P3-2）');
  assert.match(setup, /if \(sending\) return; \/\/ 送っている間は選び直せない/, '送っている間は選び直せない（codex P2-2）');
  assert.match(setup, /pickEl\.disabled = true/); assert.match(setup, /const cur = plan;/);
});
