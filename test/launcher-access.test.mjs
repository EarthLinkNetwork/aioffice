// 起動係の中継の判定（設計 docs/design/2026-11-23-public-office-multi-user.md 2.1・2.2・2.3）
import test from 'node:test';
import assert from 'node:assert/strict';
import { normPath, coreAccess, forwardHeaders } from '../packages/aioffice/launcher/lib/access.mjs';

test('path の正規化: 大文字・末尾の /・%2F・二重の encode・//・.・..・\\ を解く。読めない物は null', () => {
  assert.equal(normPath('/api/Bootstrap/Claim/'), '/api/bootstrap/claim');
  assert.equal(normPath('/api%2Fbootstrap%2Fclaim'), '/api/bootstrap/claim');
  assert.equal(normPath('/api%252Fbootstrap%252Fclaim'), '/api/bootstrap/claim');
  assert.equal(normPath('//api//auth/./sign-up/email?x=1'), '/api/auth/sign-up/email');
  assert.equal(normPath('/api/x/../bootstrap/claim'), '/api/bootstrap/claim');
  assert.equal(normPath('/api\\bootstrap\\claim'), '/api/bootstrap/claim');
  assert.equal(normPath('/a%00b'), null);
  assert.equal(normPath('/%E0%A4%A'), null);
});

const ok = (m, u, st) => coreAccess({ method: m, url: u, state: st });
test('claim の前: code の cookie が無ければ、どんな書き方の sign-up と bootstrap の claim も通さない', () => {
  const st = { stage: 'preclaim' };
  for (const u of ['/api/bootstrap/claim', '/api/Bootstrap/Claim/', '/api%2Fbootstrap%2Fclaim', '//api/bootstrap//claim', '/api/x/../bootstrap/claim', '/api/auth/Sign-Up/Email/', '/api/auth/sign-up/email?a=b'])
    assert.equal(ok('POST', u, st), 'deny', u);
  assert.equal(ok('POST', '/api/bootstrap/claim', { ...st, claimCookie: true }), 'pass');
  assert.equal(ok('POST', '/api/auth/sign-up/email', { ...st, claimCookie: true }), 'pass');
  assert.equal(ok('POST', '/api/auth/sign-in/email', st), 'pass');
  assert.equal(ok('GET', '/api/board-claim/t', { ...st, claimCookie: true }), 'deny', 'claim の前に board-claim は通さない');
});

const DENY_ALWAYS = [['PATCH', '/api/issues/i1'], ['POST', '/api/issues/i1/wakeup'], ['POST', '/api/companies/c/issues'], ['GET', '/api/companies'], ['POST', '/api/agents/a/wakeup'], ['POST', '/api/plugins/aioffice.notify/api/tick'], ['GET', '/api/companies/c/issues'], ['POST', '/assets/x.js'], ['POST', '/api/board-api-keys']];
test('鍵が無い間: sign-in 系・health・画面の静的なファイルだけ。課題の割り当て・wakeup・会社の読み出しは断る', () => {
  const st = { stage: 'keyless' };
  assert.equal(ok('POST', '/api/auth/sign-in/email', st), 'pass');
  assert.equal(ok('GET', '/api/auth/get-session', st), 'pass');
  assert.equal(ok('GET', '/api/health', st), 'pass');
  for (const u of ['/assets/index-abc.js', '/favicon.ico', '/']) assert.equal(ok('GET', u, st), 'pass', u);
  assert.equal(ok('POST', '/api/auth/sign-up/email', st), 'deny', '鍵が無い間は sign-up も通さない');
  assert.equal(ok('POST', '/api/board-claim/t/claim', st), 'deny');
  for (const [m, u] of DENY_ALWAYS) for (const stage of ['keyless', 'preclaim', 'migrating']) assert.equal(ok(m, u, { stage, claimCookie: true, ownerCookie: true }), 'deny', `${stage} ${m} ${u}`);
});

test('移し替え: 合言葉の cookie がある時だけ sign-up・sign-in・board-claim（API と画面）', () => {
  const st = { stage: 'migrating', ownerCookie: true };
  for (const [m, u] of [['POST', '/api/auth/sign-up/email'], ['POST', '/api/auth/sign-in/email'], ['GET', '/api/auth/get-session'], ['GET', '/api/board-claim/abc'], ['POST', '/api/board-claim/abc/claim'], ['POST', '/api/Board-Claim/abc/claim/'], ['GET', '/board-claim/abc']]) {
    assert.equal(ok(m, u, st), 'pass', `${m} ${u}`);
    assert.equal(ok(m, u, { stage: 'migrating' }), 'deny', `合言葉なし ${m} ${u}`);
  }
  assert.equal(ok('POST', '/api/bootstrap/claim', st), 'deny');
});

test('鍵がある時は本体に任せる・読めない path は断る', () => {
  assert.equal(ok('PATCH', '/api/issues/i1', { stage: 'ready' }), 'pass');
  assert.equal(ok('PATCH', '/api/issues/i1'), 'pass');
  assert.equal(ok('GET', '/a%00', { stage: 'ready' }), 'bad');
});

test('本体へ渡す header: ブラウザの x-forwarded-* と authorization を捨てて付け直す・[::1] は localhost', () => {
  const h = forwardHeaders({ Host: 'office.local:3100', 'X-Forwarded-Host': 'evil', 'x-forwarded-for': '1.2.3.4', forwarded: 'for=1', authorization: 'Bearer stolen', cookie: 'a=b' }, { targetHost: '127.0.0.1:3101', clientHost: 'office.local:3100', remoteAddress: '::ffff:192.168.1.5' });
  assert.equal(h.host, '127.0.0.1:3101');
  assert.equal(h['x-forwarded-host'], 'office.local:3100');
  assert.equal(h['x-forwarded-for'], '192.168.1.5');
  assert.equal(h['x-forwarded-proto'], 'http');
  assert.equal(h.authorization, undefined);
  assert.equal(h.forwarded, undefined);
  assert.equal(h['X-Forwarded-Host'], undefined);
  assert.equal(h.cookie, 'a=b');
  assert.equal(forwardHeaders({}, { targetHost: 't', clientHost: '[::1]:3100' })['x-forwarded-host'], 'localhost:3100');
  assert.equal(forwardHeaders({ 'x-forwarded-proto': 'https' }, { targetHost: 't', clientHost: 'x' })['x-forwarded-proto'], 'http', 'ブラウザの proto は信じない');
  assert.equal(forwardHeaders({}, { targetHost: 't', clientHost: 'office.example.com', proto: 'https' })['x-forwarded-proto'], 'https', '前段の住所は起動係が https と決める');
});

test('bootstrap の claim は、どの段でも claim の前・code の cookie の時だけ（ready の段でも本体に任せない・2 回目のレビュー 高 1）', () => {
  for (const u of ['/api/bootstrap/claim', '/API/Bootstrap/Claim/', '/api//bootstrap/./claim', '/api/x/../bootstrap/claim', '/api/bootstrap%2Fclaim']) {
    assert.equal(ok('POST', u, { stage: 'ready' }), 'deny', `ready ${u}`);
    assert.equal(ok('POST', u, { stage: 'ready', claimCookie: true }), 'deny', `ready + cookie ${u}`);
    assert.equal(ok('POST', u, { stage: 'keyless', claimCookie: true }), 'deny', `keyless ${u}`);
    assert.equal(ok('POST', u, { stage: 'preclaim' }), 'deny', `preclaim の cookie なし ${u}`);
    assert.equal(ok('POST', u, { stage: 'preclaim', claimCookie: true }), 'pass', `preclaim + cookie ${u}`);
  }
  assert.equal(ok('GET', '/api/companies', { stage: 'ready' }), 'pass', 'ほかの口は ready で本体に任せる');
});
