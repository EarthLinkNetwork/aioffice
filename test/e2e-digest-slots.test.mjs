// e2e の試験が「まとめ」の回を使い切らないことを固める（2026-11-20 arm64 で 2 回落ちた）。
// まとめの回は「日付と朝・夕方」（plugins/notify/src/lib.mjs の digestSlot）。e2e の newDigest は時刻帯を替えて、まだ使っていない回を選ぶ。
// 時刻帯を全部回しても、ある時点で選べる回は最少で 2 つ。起動係の見回りが今の時刻帯の回を先に 1 つ作ることがあるので、
// 1 社が newDigest で使ってよい回は 1 つまで。2 つ目が要る確かめは、別の会社で行う。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { digestSlot } from '../plugins/notify/src/lib.mjs';

const ZONES_SRC = "[...Array.from({ length: 14 }, (_, i) => `Etc/GMT-${i + 1}`), 'Etc/UTC', ...Array.from({ length: 12 }, (_, i) => `Etc/GMT+${i + 1}`)]";
const ZONES = [...Array.from({ length: 14 }, (_, i) => `Etc/GMT-${i + 1}`), 'Etc/UTC', ...Array.from({ length: 12 }, (_, i) => `Etc/GMT+${i + 1}`)];
const PATROL = 1; // 見回りが先に使いうる回の数

test('1 日のどの時刻でも、時刻帯を回して選べるまとめの回は 2 つ以上ある', () => {
  let min = Infinity;
  for (let m = 0; m < 24 * 60; m += 5) {
    const t = Date.UTC(2026, 10, 20, 0, m);
    min = Math.min(min, new Set(ZONES.map(z => digestSlot(t, z)).filter(Boolean).map(s => s.key)).size);
  }
  assert.ok(min >= 2, `最少 ${min}`);
});

test('e2e の newDigest は 1 社に 1 回まで（見回りの分と合わせて、最少の回の数を超えない）', () => {
  const dir = new URL('./e2e/', import.meta.url);
  for (const f of readdirSync(dir).filter(n => n.endsWith('.mjs'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const all = [...src.matchAll(/\bnewDigest\(/g)].length - [...src.matchAll(/function newDigest\(/g)].length;
    if (!all) continue;
    // 時刻帯の一覧は e2e の newDigest と同じでなければ、この試験の証明が e2e に当てはまらない
    assert.ok(src.includes(ZONES_SRC), `${f}: newDigest の時刻帯の一覧がこの試験の ZONES と違う`);
    const forms = [...src.matchAll(/await newDigest\((\[[\w.\s,]*\])?\)/g)];
    // 数えられる形（await newDigest() か await newDigest([識別子, …])）以外の呼び出しがあれば、数え漏れになるので落とす
    assert.equal(forms.length, all, `${f}: newDigest の呼び出し ${all} 件のうち、数えられる形は ${forms.length} 件（await と識別子の配列で書く）`);
    const per = new Map();
    for (const m of forms) {
      const arg = (m[1] || '[companyId]').trim();
      for (const c of arg.replace(/^\[|\]$/g, '').split(',').map(x => x.trim()).filter(Boolean)) per.set(c, (per.get(c) || 0) + 1);
    }
    for (const [c, n] of per) assert.ok(n + PATROL <= 2, `${f}: ${c} に newDigest を ${n} 回（見回りの分と合わせて回が足りなくなる時刻がある）`);
  }
});
