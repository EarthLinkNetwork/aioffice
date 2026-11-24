// e2e の docker の共有の口の試験（test/e2e/docker.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dockerSync, notStarted } from './e2e/docker.mjs';

const oci = () => Object.assign(new Error('Command failed'), { status: 126, stdout: 'OCI runtime exec failed: exec failed: unable to start container process: waiting for init preliminary setup: read init-p: connection reset by peer: unknown\r\n', stderr: '' });

test('起動しなかった exec だけをやり直し、2 回目の結果を返す', () => {
  let n = 0; const waits = [];
  const out = dockerSync(['exec', 'x', 'true'], {}, { run: () => { n++; if (n === 1) throw oci(); return 'ok'; }, sleep: ms => waits.push(ms) });
  assert.equal(out, 'ok'); assert.equal(n, 2); assert.deepEqual(waits, [2000]);
});

test('コマンドの失敗・時間切れはやり直さない（中で動いた操作を重ねない）', () => {
  for (const e of [Object.assign(new Error('x'), { status: 1, stderr: 'boom' }), Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT', status: null }), Object.assign(new Error('x'), { status: 126, stderr: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "x": permission denied: unknown' })]) {
    let n = 0;
    assert.throws(() => dockerSync(['exec'], {}, { run: () => { n++; throw e; }, sleep: () => {} }));
    assert.equal(n, 1); assert.equal(notStarted(e), false);
  }
});

test('stderr 側の文も拾う・exec 以外（run など）はやり直さない・既定は 4 回', () => {
  const e = Object.assign(new Error('x'), { status: 126, stdout: '', stderr: 'OCI runtime exec failed: exec failed: unable to start container process: waiting for init preliminary setup: read init-p: connection reset by peer: unknown' });
  assert.equal(notStarted(e), true);
  let n = 0;
  assert.throws(() => dockerSync(['run', '-d', 'x'], {}, { run: () => { n++; throw oci(); }, sleep: () => {} })); assert.equal(n, 1);
  n = 0;
  assert.throws(() => dockerSync(['exec', 'x'], {}, { run: () => { n++; throw oci(); }, sleep: () => {} })); assert.equal(n, 4);
});

test('dockerSync を使うファイルは、最初の文字列より前（外側）で ./docker.mjs を import している（レビュー P1）', () => {
  const dir = new URL('./e2e/', import.meta.url), bad = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.mjs') && n !== 'docker.mjs')) {
    const t = readFileSync(new URL(f, dir), 'utf8'); if (!t.includes('dockerSync(')) continue;
    const at = t.search(/^import \{ dockerSync \} from '\.\/docker\.mjs';$/m), tick = t.indexOf('`');
    if (at < 0 || (tick >= 0 && at > tick)) bad.push(f);
  }
  assert.deepEqual(bad, []);
});

test('やり直しには上限があり、最後の失敗を投げる', () => {
  let n = 0;
  assert.throws(() => dockerSync(['exec'], {}, { tries: 3, run: () => { n++; throw oci(); }, sleep: () => {} }), /Command failed/);
  assert.equal(n, 3);
});

// spawnSync は投げないので数えない（失敗の時に docker logs を集める所）
test('e2e は docker を共有の口からだけ呼ぶ', () => {
  const dir = new URL('./e2e/', import.meta.url), bad = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.mjs') && n !== 'docker.mjs')) {
    readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((l, i) => { if (/(?:execFileSync|execSync)\(\s*['"`]docker/.test(l)) bad.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(bad, []);
});
