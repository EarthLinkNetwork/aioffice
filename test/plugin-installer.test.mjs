// image に焼き込んだ plugin を本体に入れる処理（packages/aioffice/launcher/lib/plugins.mjs）の試験。本体と CLI は偽物
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPluginInstaller, readBundled } from '../packages/aioffice/launcher/lib/plugins.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aio-plugins-'));
function bundle(root, name, key, buildId) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BUILD_ID'), buildId); fs.writeFileSync(path.join(dir, 'PLUGIN_KEY'), JSON.stringify({ key }));
  return dir;
}
// 本体の偽物: health と plugin の一覧。CLI の偽物は install・upgrade・uninstall を一覧に反映する
function fakeHost({ healthy = true, installed = [] } = {}) {
  const plugins = new Map(installed.map(p => [p.pluginKey, p]));
  const calls = [];
  const fetchFn = async url => {
    const p = new URL(url).pathname;
    if (p === '/api/health') return { ok: healthy, json: async () => ({}) };
    if (p === '/api/plugins') return { ok: true, json: async () => [...plugins.values()] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const runCli = async (_bin, args) => {
    calls.push(args.slice(0, 3).join(' '));
    const [, cmd, a2, a3] = args;
    if (cmd === 'install') { const dir = a3; const key = JSON.parse(fs.readFileSync(path.join(dir, 'PLUGIN_KEY'), 'utf8')).key; plugins.set(key, { pluginKey: key, status: 'ready', packagePath: dir }); }
    if (cmd === 'upgrade') { const p = plugins.get(a2); if (p) p.status = 'ready'; }
    if (cmd === 'uninstall') plugins.delete(a2);
    return { ok: true, out: '', err: '' };
  };
  return { fetchFn, runCli, calls, plugins };
}
const make = (host, pluginsDir, dataDir) => createPluginInstaller({ pcUrl: 'http://127.0.0.1:3101', dataDir, pluginsDir, fetchFn: host.fetchFn, runCli: host.runCli, sleep: async () => {}, healthTries: 3, healthRounds: 2 });

test('BUILD_ID と PLUGIN_KEY のある置き場だけを読む', () => {
  const root = tmp(); bundle(root, 'office', 'aioffice.office', 'b1'); fs.mkdirSync(path.join(root, 'broken'));
  assert.deepEqual(readBundled(root).map(b => [b.name, b.key, b.buildId]), [['office', 'aioffice.office', 'b1']]);
  assert.deepEqual(readBundled(path.join(root, 'none')), []);
});

test('入っていなければ install し、ready と BUILD_ID を記録する', async () => {
  const root = tmp(), data = tmp(); bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost();
  const rec = await make(host, root, data).ensure();
  assert.deepEqual(host.calls, ['plugin install --local']);
  assert.equal(rec['aioffice.office'].status, 'ready'); assert.equal(rec['aioffice.office'].buildId, 'b1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'plugins.json'), 'utf8'))['aioffice.office'].buildId, 'b1');
});

test('同じ中身で ready なら何もしない（2 回目の起動）', async () => {
  const root = tmp(), data = tmp(); const dir = bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost();
  await make(host, root, data).ensure();
  host.calls.length = 0;
  await make(host, root, data).ensure();
  assert.deepEqual(host.calls, []);
  assert.equal(host.plugins.get('aioffice.office').packagePath, dir);
});

test('中身が変わったら upgrade する（install し直すと本体は 400 を返すため）', async () => {
  const root = tmp(), data = tmp(); bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost();
  await make(host, root, data).ensure();
  bundle(root, 'office', 'aioffice.office', 'b2'); host.calls.length = 0;
  const rec = await make(host, root, data).ensure();
  assert.deepEqual(host.calls, ['plugin upgrade aioffice.office']);
  assert.equal(rec['aioffice.office'].buildId, 'b2');
});

test('ready でなければ upgrade で起こし直す', async () => {
  const root = tmp(), data = tmp(); const dir = bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost({ installed: [{ pluginKey: 'aioffice.office', status: 'error', packagePath: dir }] });
  fs.writeFileSync(path.join(data, 'plugins.json'), JSON.stringify({ 'aioffice.office': { buildId: 'b1', status: 'ready' } }));
  await make(host, root, data).ensure();
  assert.deepEqual(host.calls, ['plugin upgrade aioffice.office']);
});

test('置き場が違えば外して入れ直す', async () => {
  const root = tmp(), data = tmp(); bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost({ installed: [{ pluginKey: 'aioffice.office', status: 'ready', packagePath: '/old/place' }] });
  await make(host, root, data).ensure();
  assert.deepEqual(host.calls, ['plugin uninstall aioffice.office', 'plugin install --local']);
});

test('本体が起きなければ入れずに failed を記録する（起動は止めない）', async () => {
  const root = tmp(), data = tmp(); bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost({ healthy: false });
  const rec = await make(host, root, data).ensure();
  assert.deepEqual(host.calls, []);
  assert.deepEqual([rec['aioffice.office'].status, rec['aioffice.office'].error], ['failed', 'paperclip_not_ready']);
});

test('入れた後に ready にならなければ failed を記録する', async () => {
  const root = tmp(), data = tmp(); bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost();
  const inner = host.runCli; host.runCli = async (b, a) => { const r = await inner(b, a); host.plugins.get('aioffice.office').status = 'error'; return r; };
  const rec = await make(host, root, data).ensure();
  assert.deepEqual([rec['aioffice.office'].status, rec['aioffice.office'].error], ['failed', 'status_error']);
});

test('同時に 2 回呼ばれても 1 回にまとめる', async () => {
  const root = tmp(), data = tmp(); bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost(); const inst = make(host, root, data);
  await Promise.all([inst.ensure(), inst.ensure()]);
  assert.deepEqual(host.calls, ['plugin install --local']);
});

test('upgrade の CLI が失敗したら、前の版が ready のままでも failed にし、BUILD_ID は前のまま（次の起動でやり直す）', async () => {
  const root = tmp(), data = tmp(); const dir = bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost(); await make(host, root, data).ensure();
  fs.writeFileSync(path.join(dir, 'BUILD_ID'), 'b2');
  const inner = host.runCli; host.runCli = async (b, a) => (a[1] === 'upgrade' ? (host.calls.push('plugin upgrade x'), { ok: false, out: '', err: 'capability escalation' }) : inner(b, a));
  const rec = await make(host, root, data).ensure();
  assert.deepEqual([rec['aioffice.office'].status, rec['aioffice.office'].error, rec['aioffice.office'].buildId], ['failed', 'install_failed', 'b1']);
  host.runCli = inner; host.calls.length = 0;
  const rec2 = await make(host, root, data).ensure();
  assert.deepEqual(host.calls, ['plugin upgrade aioffice.office']);
  assert.deepEqual([rec2['aioffice.office'].status, rec2['aioffice.office'].buildId], ['ready', 'b2']);
});

test('本体が約 3 分で起きなくても、裏で待ち続け、起きたら入れる', async () => {
  const root = tmp(), data = tmp(); bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost(); let n = 0;
  const inner = host.fetchFn; host.fetchFn = async url => (new URL(url).pathname === '/api/health' ? { ok: ++n > 4, json: async () => ({}) } : inner(url));
  const seen = [];
  const inst = createPluginInstaller({ pcUrl: 'http://127.0.0.1:3101', dataDir: data, pluginsDir: root, fetchFn: host.fetchFn, runCli: host.runCli, sleep: async () => { seen.push(JSON.parse(fs.existsSync(path.join(data, 'plugins.json')) ? fs.readFileSync(path.join(data, 'plugins.json'), 'utf8') : '{}')['aioffice.office']?.status ?? null); }, healthTries: 3, healthRounds: 5 });
  const rec = await inst.ensure();
  assert.ok(seen.includes('failed'), '待っている間は failed が出る');
  assert.equal(rec['aioffice.office'].status, 'ready');
  assert.deepEqual(host.calls, ['plugin install --local']);
});

test('照合の途中で呼ばれたら（本体の起こし直し）、終わった後にもう 1 回照合する', async () => {
  const root = tmp(), data = tmp(); bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost(); let inst = null;
  const inner = host.runCli; let second = null;
  host.runCli = async (b, a) => { const r = await inner(b, a); if (!second) { host.plugins.delete('aioffice.office'); second = inst.ensure(); } return r; }; // 入れた直後に本体が落ちて中身を失った
  inst = make(host, root, data);
  const rec = await inst.ensure();
  assert.equal(await second, rec);
  assert.deepEqual(host.calls, ['plugin install --local', 'plugin install --local']);
  assert.equal(rec['aioffice.office'].status, 'ready');
});

test('本体が遅くて failed を書いた後でも、同じ中身が ready なら CLI を呼ばずに ready と記録する', async () => {
  const root = tmp(), data = tmp(); bundle(root, 'office', 'aioffice.office', 'b1');
  const host = fakeHost(); await make(host, root, data).ensure();
  const rec0 = JSON.parse(fs.readFileSync(path.join(data, 'plugins.json'), 'utf8'));
  rec0['aioffice.office'] = { ...rec0['aioffice.office'], status: 'failed', error: 'paperclip_not_ready' };
  fs.writeFileSync(path.join(data, 'plugins.json'), JSON.stringify(rec0));
  host.calls.length = 0;
  const rec = await make(host, root, data).ensure();
  assert.deepEqual(host.calls, []);
  assert.deepEqual([rec['aioffice.office'].status, rec['aioffice.office'].error, rec['aioffice.office'].buildId], ['ready', null, 'b1']);
});
