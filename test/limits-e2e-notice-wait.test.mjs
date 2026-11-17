// 上限の e2e で、取り消した run の id を知らせの中に探す確かめは、知らせが出るまで待つ（waitFor）形で書く（2026-11-21 arm64 の 12 で、取り消しを見た直後に 1 回だけ読んで落ちた）。
// 取り消した回の /tick が上限の処理を飛ばすと、知らせは次の回で出る。取り消しを見た時点では知らせがまだ無いことがある
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('limits.e2e: 知らせの中に run の id を探す行は、waitFor の中か、直前の行の waitFor で同じ run を待った後に読む', () => {
  const lines = readFileSync(new URL('./e2e/limits.e2e.mjs', import.meta.url), 'utf8').split('\n');
  let n = 0;
  lines.forEach((l, i) => {
    const m = l.match(/ofKind\('[a-z_]+'\)\).*\.includes\((run\w*)\.id\)/);
    if (!m) return;
    n++;
    const inWait = /^await waitFor\(/.test(l);
    const prev = lines[i - 1] || '';
    const afterWait = /^await waitFor\(/.test(prev) && prev.includes(`${m[1]}.id`) && prev.includes('ofKind(');
    assert.ok(inWait || afterWait, `${i + 1} 行: 知らせの中の ${m[1]} を待たずに読んでいる`);
  });
  assert.ok(n >= 3, `数えた行 ${n}`);
});
