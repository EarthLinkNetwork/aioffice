// 回覧が人に届いた時のメール（設計 docs/design/2026-11-23-public-office-multi-user.md 2.6）
// 持ち主のメールの知らせが ON の会社で、ON にした後に回覧が人に開いた答えの口（interaction）ごとに、持ち主が確かめた住所へ 1 回送る
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLauncher } from '../packages/aioffice/launcher/server.mjs';
import { createBoardKey } from '../packages/aioffice/launcher/lib/board-key.mjs';
import { mailFingerprint, mailPreviewHash } from '../packages/aioffice/launcher/lib/mail-core.mjs';
import { buildMime } from '../packages/aioffice/launcher/lib/smtp.mjs';

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const ON_AT = '2026-11-24T00:00:00.000Z', AFTER = '2026-11-24T01:00:00.000Z';
const OFFICE = 'http://localhost:3100/AAA/office';
const issue = (id, x) => ({ id, identifier: `AAA-${id.slice(1)}`, title: `title ${id}`, companyId: 'c1', status: 'todo', createdAt: AFTER, originKind: 'plugin:aioffice.relay', ...x });
const pending = (id, who, x) => ({ id, status: 'pending', addresseeUserId: who, createdAt: AFTER, ...x });
const ok = { ok: true, code: 250, stage: 'done' };

// replies: 送るたびに順に返す答え（尽きたら最後の物を返し続ける）。interactions: 課題の id → 答えの口の一覧（試験の中で書き換えられる）
async function setup({ issues, interactions, people, mailOn = true, replies = [ok], keep }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-relay-mail-'));
  const hits = [];
  const core = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/api/companies/c1/issues')) return res.end(JSON.stringify(typeof issues === 'function' ? issues(new URL(req.url, 'http://x').searchParams) : issues));
    const m = req.url.match(/^\/api\/issues\/([^/]+)\/interactions$/);
    if (m) return res.end(JSON.stringify(interactions[m[1]] || []));
    if (req.url === '/api/cli-auth/me') return res.end(JSON.stringify({ isInstanceAdmin: true, source: 'board_key' }));
    return res.end('{}');
  });
  const corePort = await listen(core);
  const dataDir = path.join(dir, 'aioffice'); fs.mkdirSync(dataDir, { recursive: true });
  const addr = 'owner@gmail.com', pw = 'abcdefghijklmnop', fp = mailFingerprint({ addr, pw });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    v: 2, lang: 'en', people,
    mail: { c1: { addr, pw, fp, on: mailOn, onAt: ON_AT, kinds: ['digest'], form: 'titles', lang: 'en', officeUrl: OFFICE, hash: mailPreviewHash({ fp, kinds: ['digest'], form: 'titles', lang: 'en', officeUrl: OFFICE }) } },
  }));
  const boardKey = createBoardKey({ dataDir }); boardKey.write({ id: 'k1', token: 'pcp_ok' });
  const sent = []; let k = 0;
  const L = createLauncher({ dataDir, paperclipUrl: `http://127.0.0.1:${corePort}`, codexHome: path.join(dir, 'codex'), boardKey, spawnFn: () => { throw new Error('no spawn'); }, ...(keep ? { relayMailKeep: keep } : {}),
    mailDeps: { send: async m => { await m.before?.(); sent.push(m); return replies[Math.min(k++, replies.length - 1)]; } } });
  return { L, sent, hits, dataDir, close: () => { L.server.close(); core.close(); } };
}
const confirmed = { a: { mail: 'a@corp.test', mailConfirmed: true }, b: { mail: 'b@corp.test', mailConfirmed: true } };
// 本体の一覧のまね: 課題の id の昇順・afterId より後・limit 件（offset は使わない。afterId と offset は本体が一緒に受けない）
const byId = (list, sp) => { const a = sp.get('afterId'); if (sp.get('offset')) throw new Error('offset は使わない'); return [...list].sort((x, y) => (x.id < y.id ? -1 : 1)).filter(i => !a || i.id > a).slice(0, Number(sp.get('limit') || 500)); };
const pad = k => String(k).padStart(5, '0');

test('確かめた住所の人にだけ、持ち主の Gmail から答えの口ごとに 1 回送る（確かめていない人・ON の前の口・回覧でない課題・閉じた課題・答えた口には送らない）', async t => {
  const e = await setup({
    issues: [
      issue('y1', { assigneeUserId: 'a' }), issue('y2', { assigneeUserId: 'b' }), issue('y3', { assigneeUserId: 'a' }),
      issue('y4', { assigneeUserId: 'a', originKind: 'manual' }), issue('y5', { assigneeUserId: 'a', status: 'done' }), issue('y6', { assigneeUserId: 'a' }),
    ],
    interactions: { y1: [pending('i1', 'a')], y2: [pending('i2', 'b')], y3: [pending('i3', 'a', { createdAt: '2026-11-23T23:00:00.000Z' })], y4: [pending('i4', 'a')], y5: [pending('i5', 'a')], y6: [pending('i6', 'a', { status: 'answered' })] },
    people: { a: confirmed.a, b: { mail: 'b@corp.test', mailConfirmed: false } },
  });
  t.after(e.close);
  assert.deepEqual(await e.L.relayMail(), { c1: 1 });
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].to, 'a@corp.test', '確かめた住所へ');
  assert.equal(e.sent[0].addr, 'owner@gmail.com', '送る元は持ち主の Gmail');
  assert.match(e.sent[0].text, /AAA-1 title y1/);
  assert.match(e.sent[0].text, /• http:\/\/localhost:3100\/AAA\/issues\/AAA-1\n/, '課題の URL は office の URL の住所から組み立てる');
  assert.ok(e.hits.some(u => /updatedSince=2026-11-24T00%3A00%3A00\.000Z/.test(u)), 'ON にした時から後を読む');
  assert.deepEqual(await e.L.relayMail(), { c1: 0 }, '同じ答えの口には 2 度送らない');
});

test('戻りの段: 同じ課題に新しい答えの口ができたら、もう 1 通送る（2 回目のレビュー 中 3）', async t => {
  const interactions = { y1: [pending('i1', 'a')] };
  const e = await setup({ issues: [issue('y1', { assigneeUserId: 'a' })], interactions, people: confirmed });
  t.after(e.close);
  await e.L.relayMail();
  interactions.y1 = [pending('i1', 'a', { status: 'accepted' }), pending('i9', 'a', { createdAt: '2026-11-24T05:00:00.000Z' })];
  await e.L.relayMail();
  assert.equal(e.sent.length, 2);
  assert.notEqual(e.sent[0].messageId, e.sent[1].messageId, 'Message-ID も段ごとに違う');
});

test('宛先が断った（550 5.1.1・RCPT の 552）1 通はやめ、持ち主のメールは ON のまま・ほかの人には続けて送る', async t => {
  const e = await setup({
    issues: [issue('y1', { assigneeUserId: 'a' }), issue('y2', { assigneeUserId: 'b' })],
    interactions: { y1: [pending('i1', 'a')], y2: [pending('i2', 'b')] }, people: confirmed,
    replies: [{ ok: false, code: 552, ext: '5.2.2', stage: 'rcpt' }, ok],
  });
  t.after(e.close);
  assert.deepEqual(await e.L.relayMail(), { c1: 1 });
  assert.deepEqual(e.sent.map(m => m.to), ['a@corp.test', 'b@corp.test']);
  assert.equal(e.L.mail.mailOf('c1').on, true);
  await e.L.relayMail();
  assert.equal(e.sent.length, 2, '断られた 1 通はやり直さない');
  const e2 = await setup({ issues: [issue('y1', { assigneeUserId: 'a' })], interactions: { y1: [pending('i1', 'a')] }, people: confirmed, replies: [{ ok: false, code: 550, ext: '5.1.1', stage: 'rcpt' }] });
  t.after(e2.close);
  await e2.L.relayMail();
  assert.equal(e2.L.mail.mailOf('c1').on, true, '550 5.1.1 でも持ち主のメールは OFF にしない');
});

test('宛先の 1 通の一時的な失敗（RCPT の 4xx）は、ほかの人を止めず、間を空けて 3 回まで', async t => {
  const e = await setup({
    issues: [issue('y1', { assigneeUserId: 'a' }), issue('y2', { assigneeUserId: 'b' })],
    interactions: { y1: [pending('i1', 'a')], y2: [pending('i2', 'b')] }, people: confirmed,
    replies: [{ ok: false, code: 450, ext: '4.2.1', stage: 'rcpt' }, ok],
  });
  t.after(e.close);
  await e.L.relayMail();
  assert.deepEqual(e.sent.map(m => m.to), ['a@corp.test', 'b@corp.test'], 'a の失敗で b を止めない');
  await e.L.relayMail();
  assert.equal(e.sent.length, 2, '間を空ける（次の分にはすぐ送り直さない）');
  assert.equal(e.L.store.get().relayMail.c1.tries['y1:i1'].n, 1);
});

test('つながらない時は、その会社の送りを次の分に回す（印は付けない）', async t => {
  const e = await setup({ issues: [issue('y1', { assigneeUserId: 'a' }), issue('y2', { assigneeUserId: 'b' })], interactions: { y1: [pending('i1', 'a')], y2: [pending('i2', 'b')] }, people: confirmed,
    replies: [{ ok: false, tag: 'network', stage: 'connect' }, ok] });
  t.after(e.close);
  await e.L.relayMail();
  assert.equal(e.sent.length, 1, 'つながらない時は後ろの人に続けない');
  await e.L.relayMail();
  assert.deepEqual(e.sent.slice(1).map(m => m.to), ['a@corp.test', 'b@corp.test'], '次の分に両方送る');
});

test('DATA の後に答えが無い（届いたかもしれない）1 通は送り直さない', async t => {
  const e = await setup({ issues: [issue('y1', { assigneeUserId: 'a' })], interactions: { y1: [pending('i1', 'a')] }, people: confirmed,
    replies: [{ ok: false, tag: 'timeout', stage: 'data_end' }, ok] });
  t.after(e.close);
  await e.L.relayMail(); await e.L.relayMail();
  assert.equal(e.sent.length, 1);
});

test('回覧のメールは、持ち主自身への知らせの 1 時間の上限を食わない', async t => {
  const e = await setup({ issues: [issue('y1', { assigneeUserId: 'a' })], interactions: { y1: [pending('i1', 'a')] }, people: confirmed });
  t.after(e.close);
  await e.L.relayMail();
  const st = e.L.mail.mailOf('c1');
  assert.equal(st.hour, undefined, '持ち主の 1 時間の数えに入れない');
  assert.equal(st.relayHour.n, 1);
  assert.equal(st.day.n, 1, '1 日の数え（Gmail の枠）には入れる');
});

test('持ち主のメールの知らせが OFF なら送らない', async t => {
  const e = await setup({ issues: [issue('y1', { assigneeUserId: 'a' })], interactions: { y1: [pending('i1', 'a')] }, people: confirmed, mailOn: false });
  t.after(e.close);
  assert.deepEqual(await e.L.relayMail(), {});
  assert.equal(e.sent.length, 0);
});

test('MIME の To は渡した宛先・From は持ち主（既定は From と同じ）', () => {
  const m = buildMime({ addr: 'o@gmail.com', to: 'a@corp.test', subject: 's', text: 't', html: '<p>t</p>', messageId: '<x@y>' });
  assert.match(m, /^From: <o@gmail\.com>\r\nTo: <a@corp\.test>/);
  assert.match(buildMime({ addr: 'o@gmail.com', subject: 's', text: 't', html: '<p>t</p>', messageId: '<x@y>' }), /To: <o@gmail\.com>/);
});

test('500 件を超える時は次のページも読む（1 ページ目に無い回覧の課題にも送る・独立レビュー 5 回目 低 7）', async t => {
  const list = [...Array.from({ length: 500 }, (_, k) => issue(`f${pad(k)}`, { status: 'done' })), issue('y1', { assigneeUserId: 'a' })];
  const pages = q => (q.get('originKindPrefix') === 'plugin:aioffice.relay' && q.get('sortField') === 'id' && q.get('sortDir') === 'asc' ? byId(list, q) : []);
  const e = await setup({ issues: pages, interactions: { y1: [pending('i1', 'a')] }, people: confirmed });
  t.after(e.close);
  assert.deepEqual(await e.L.relayMail(), { c1: 1 });
  assert.equal(e.sent[0].to, 'a@corp.test');
});

test('1 回の見回りで 1 万件を超える時は since を進めない（残りは次の分・6 回目のレビュー 低 2）', async t => {
  const list = Array.from({ length: 10001 }, (_, k) => issue(`f${pad(k)}`, { status: 'done' }));
  const e = await setup({ issues: q => byId(list, q), interactions: {}, people: confirmed });
  t.after(e.close);
  await e.L.relayMail();
  assert.equal(e.L.store.get().relayMail.c1.since, '2026-11-24T00:00:00.000Z', 'since は ON にした時のまま');
});

test('送った印が上限を超えても、更新で読み直した未回答の口に 2 度送らない・閉じた課題の印は外す（codex の最終確認 P2）', async t => {
  const at = n => `2026-11-24T0${n}:00:00.000Z`;
  const list = [issue('y1', { assigneeUserId: 'a' }), issue('y2', { assigneeUserId: 'a' }), issue('y3', { assigneeUserId: 'a' }), issue('y4', { assigneeUserId: 'a' })];
  const interactions = { y1: [pending('i1', 'a', { createdAt: at(1) })], y2: [pending('i2', 'a', { createdAt: at(2) })], y3: [pending('i3', 'a', { createdAt: at(3) })], y4: [pending('i4', 'a', { createdAt: at(4) })] };
  const e = await setup({ issues: () => list, interactions, people: confirmed, keep: 2 });
  t.after(e.close);
  assert.deepEqual(await e.L.relayMail(), { c1: 4 });
  const rm = () => JSON.parse(fs.readFileSync(path.join(e.dataDir, 'state.json'), 'utf8')).relayMail.c1;
  assert.equal(Object.keys(rm().sent).length, 2, '印は上限まで');
  assert.deepEqual(await e.L.relayMail(), { c1: 0 }, '印を外した未回答の口（i1・i2）にも、課題が更新されて読み直しても 2 度送らない');
  interactions.y1 = [pending('i1', 'a', { createdAt: at(1), status: 'accepted' }), pending('i9', 'a', { createdAt: at(5) })];
  assert.deepEqual(await e.L.relayMail(), { c1: 1 }, '上限の後にできた新しい口には送る');
  list[2] = { ...list[2], status: 'done' };
  await e.L.relayMail();
  assert.ok(!Object.keys(rm().sent).some(k => k.startsWith('y3:')), '閉じた課題の印は外す');
  assert.equal(e.sent.length, 5);
});

test('時刻の無い印（公開前の途中の版の配列）は持たず、壊れずに印を作り直す（12 回目のレビュー P3-3）', async t => {
  const e = await setup({ issues: [issue('y1', { assigneeUserId: 'a' })], interactions: { y1: [pending('i1', 'a')] }, people: confirmed });
  t.after(e.close);
  e.L.store.update(x => { x.relayMail = { c1: { since: ON_AT, sent: ['y1:i1'] } }; });
  await e.L.relayMail();
  const sent = e.L.store.get().relayMail.c1.sent;
  assert.ok(!Array.isArray(sent) && Object.values(sent).every(v => Number.isFinite(v) && v > 0), '印は口の作成時刻つきの形だけ');
  assert.deepEqual(await e.L.relayMail(), { c1: 0 }, '作り直した印で、同じ口に 2 度送らない');
});

test('送り直しを待つ口は、上限で印を外しても打ち切らない（codex の確かめ直し P2 の失敗の順序）', async t => {
  const at = n => `2026-11-24T0${n}:00:00.000Z`;
  const e = await setup({
    issues: [issue('y1', { assigneeUserId: 'a' }), issue('y2', { assigneeUserId: 'b' }), issue('y3', { assigneeUserId: 'b' }), issue('y4', { assigneeUserId: 'b' })],
    interactions: { y1: [pending('i1', 'a', { createdAt: at(1) })], y2: [pending('i2', 'b', { createdAt: at(2) })], y3: [pending('i3', 'b', { createdAt: at(3) })], y4: [pending('i4', 'b', { createdAt: at(4) })] },
    people: confirmed, keep: 2, replies: [{ ok: false, code: 450, ext: '4.2.1', stage: 'rcpt' }, ok],
  });
  t.after(e.close);
  await e.L.relayMail();
  assert.equal(e.sent.length, 4, 'A の一時的な失敗・B・C・D');
  const rm = e.L.store.get().relayMail.c1;
  assert.ok(!(rm.horizon >= Date.parse(at(1))), `horizon は送り直しを待つ A より前まで: ${rm.horizon}`);
  e.L.store.update(x => { x.relayMail.c1.tries['y1:i1'].next = 1; }); // 送り直しの時刻が来た
  await e.L.relayMail();
  assert.deepEqual(e.sent.slice(4).map(m => m.to), ['a@corp.test'], '宛先が戻れば A に届く');
});

test('つながらずに止めた後の口も、上限で印を外して打ち切らない（codex の確かめ直し P2 の兄弟）', async t => {
  const at = n => `2026-11-24T0${n}:00:00.000Z`;
  const e = await setup({
    issues: [issue('y1', { assigneeUserId: 'a' }), issue('y2', { assigneeUserId: 'b' })],
    interactions: { y1: [pending('i1', 'a', { createdAt: at(3) })], y2: [pending('i2', 'b', { createdAt: at(1) })] },
    people: confirmed, keep: 1, replies: [ok, { ok: false, tag: 'network', stage: 'connect' }, ok],
  });
  t.after(e.close);
  e.L.store.update(x => { x.relayMail = { c1: { since: ON_AT, sent: { 'z1:j1': Date.parse(at(2)) } } }; });
  await e.L.relayMail();
  assert.ok(!(e.L.store.get().relayMail.c1.horizon >= Date.parse(at(1))), 'まだ送っていない y2 の口を越えて horizon を進めない');
  await e.L.relayMail();
  assert.deepEqual(e.sent.map(m => m.to), ['a@corp.test', 'b@corp.test', 'b@corp.test'], '次の分に y2 へ届く');
});

test('課題の一覧を読み切れなかった回は印を外さず、見えていない未送信の口を打ち切らない（15 回目のレビュー P2）', async t => {
  const at = n => `2026-11-24T0${n}:00:00.000Z`;
  // 1 万件を超えて読み切れない回: z1 は 1 万件の後ろにあり、その回には見えない
  const filler = Array.from({ length: 10000 }, (_, j) => issue(`f${pad(j)}`, { status: 'done' }));
  let round = 0;
  const e = await setup({
    issues: sp => byId(round === 0 ? [...filler, issue('z1', { assigneeUserId: 'a' })] : [issue('z1', { assigneeUserId: 'a' })], sp),
    interactions: { z1: [pending('iz', 'a', { createdAt: at(1) })] },
    people: confirmed, keep: 1,
  });
  t.after(e.close);
  e.L.store.update(x => { x.relayMail = { c1: { since: ON_AT, sent: { 'p1:j1': Date.parse(at(2)), 'p2:j2': Date.parse(at(3)) } } }; });
  await e.L.relayMail();
  assert.ok(!(e.L.store.get().relayMail.c1.horizon >= Date.parse(at(1))), '読み切れなかった回は horizon を進めない');
  round = 1;
  await e.L.relayMail();
  assert.deepEqual(e.sent.map(m => m.to), ['a@corp.test'], '読み切れなかった回の後でも z1 に届く');
});

test('読む間に読んだ課題が消えても（2 ページ目が空になるほどでも）、前のページの最後の id から読むので読み落とさない（16〜17 回目のレビュー P2）', async t => {
  for (const gone of [10, 60, 100]) {
    const list = [...Array.from({ length: 500 }, (_, j) => issue(`f${pad(j)}`, { assigneeUserId: 'nobody' })), issue('z1', { assigneeUserId: 'a' })];
    let reads = 0;
    const e = await setup({
      // 1 ページ目を読んだ直後に、読んだ課題の先頭 gone 件が列から消える
      issues: sp => { const r = byId(list, sp); if (reads++ === 0) list.splice(0, gone); return r; },
      interactions: { z1: [pending('iz', 'a')] }, people: confirmed,
    });
    assert.deepEqual(await e.L.relayMail(), { c1: 1 }, `${gone} 件消えても z1 に届く`);
    assert.notEqual(e.L.store.get().relayMail.c1.since, ON_AT, '読み切れた回は since を進める');
    e.close();
  }
});
