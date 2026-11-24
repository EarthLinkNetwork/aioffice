// 本体を起こす env（設計 docs/design/2026-11-23-public-office-multi-user.md 2.1）
import test from 'node:test';
import assert from 'node:assert/strict';
import { coreEnv, parseHosts } from '../packages/aioffice/launcher/lib/core-env.mjs';

const base = { PATH: '/bin', BETTER_AUTH_SECRET: 's', PAPERCLIP_AGENT_JWT_SECRET: 'j', PAPERCLIP_API_KEY: 'k', HEARTBEAT_SCHEDULER_ENABLED: 'true', TRUST_PROXY: 'true' };

test('ログインのある形・loopback で起こし、秘密と外から来た守りの値を渡さない', () => {
  const e = coreEnv({ base, port: 3101, codexHome: '/data/codex-home', keyless: false });
  assert.equal(e.PAPERCLIP_DEPLOYMENT_MODE, 'authenticated');
  assert.equal(e.PAPERCLIP_DEPLOYMENT_EXPOSURE, 'private');
  assert.equal(e.HOST, '127.0.0.1');
  assert.equal(e.PORT, '3101');
  assert.equal(e.TRUST_PROXY, 'loopback');
  assert.equal(e.PAPERCLIP_PUBLIC_URL, 'http://localhost:3100');
  assert.equal(e.PAPERCLIP_API_URL, 'http://127.0.0.1:3101', '担当は起動係を通らず本体へ（起動係は authorization を捨てる）');
  assert.equal(e.BETTER_AUTH_TRUSTED_ORIGINS, 'http://localhost:*,http://127.0.0.1:*');
  for (const k of ['BETTER_AUTH_SECRET', 'PAPERCLIP_AGENT_JWT_SECRET', 'PAPERCLIP_API_KEY', 'HEARTBEAT_SCHEDULER_ENABLED', 'PAPERCLIP_ALLOWED_HOSTNAMES']) assert.equal(e[k], undefined, k);
  assert.equal(e.PATH, '/bin');
});

test('鍵が無い間は担当の時間での起こしを止める', () => {
  assert.equal(coreEnv({ base, port: 3101, codexHome: '/c', keyless: true }).HEARTBEAT_SCHEDULER_ENABLED, 'false');
});

test('LAN の住所: AIOFFICE_HOSTS から本体の hostname と origin を作る・手元の名前は数えない・書き方の誤りは止める', () => {
  const e = coreEnv({ base, port: 3101, codexHome: '/c', hosts: 'Office.local:3100, 192.168.1.20:3100,localhost:3100,office.local:3100', keyless: false });
  assert.equal(e.PAPERCLIP_ALLOWED_HOSTNAMES, 'office.local,192.168.1.20');
  assert.equal(e.BETTER_AUTH_TRUSTED_ORIGINS, 'http://localhost:*,http://127.0.0.1:*,http://office.local:3100,http://192.168.1.20:3100');
  assert.deepEqual(parseHosts(''), []);
  assert.throws(() => parseHosts('office.local'), /名前:port/);
  assert.throws(() => parseHosts('evil.example:3100/x'), /名前:port/);
});

test('https の前段（Cloudflare Tunnel など）の住所: https://名前 を読み、本体の hostname と https の origin を作る', () => {
  assert.deepEqual(parseHosts('https://Office.Example.com, office.lan:3100, https://office.example.com/'), ['https://office.example.com', 'office.lan:3100']);
  assert.deepEqual(parseHosts('https://office.example.com:443,https://office.example.com:8443'), ['https://office.example.com', 'https://office.example.com:8443'], ':443 はブラウザの Host に付かないので外す');
  const e = coreEnv({ base, port: 3101, codexHome: '/c', hosts: 'https://office.example.com', keyless: false });
  assert.equal(e.PAPERCLIP_ALLOWED_HOSTNAMES, 'office.example.com');
  assert.equal(e.BETTER_AUTH_TRUSTED_ORIGINS, 'http://localhost:*,http://127.0.0.1:*,https://office.example.com');
  for (const bad of ['https://evil.example/x', 'https://', 'http://office.example.com', 'https://user@evil.example']) assert.throws(() => parseHosts(bad), /https:\/\/名前/, bad);
});
