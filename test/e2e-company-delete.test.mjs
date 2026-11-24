import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteCompany } from './e2e/company-delete.mjs';

function fake(statuses, left = []) {
  const calls = [];
  const request = (m, p) => {
    calls.push(`${m} ${p}`);
    if (m === 'DELETE') return { status: statuses.shift(), text: '{"error":"Internal server error"}' };
    return { status: 200, text: JSON.stringify(left.map(id => ({ id }))) };
  };
  return { calls, request };
}
const opts = { sleep: () => {}, log: () => {} };

test('500 の時だけ消し直し、消せたら一覧で確かめる', () => {
  const f = fake([500, 500, 200]);
  deleteCompany(f.request, 'c2', opts);
  assert.deepEqual(f.calls, ['DELETE /companies/c2', 'DELETE /companies/c2', 'DELETE /companies/c2', 'GET /companies']);
});
test('消し直しで 404 になったら消せたとみなす', () => {
  const f = fake([500, 404]);
  deleteCompany(f.request, 'c2', opts);
  assert.equal(f.calls.at(-1), 'GET /companies');
});
test('500 以外の失敗は消し直さない', () => {
  const f = fake([403]);
  assert.throws(() => deleteCompany(f.request, 'c2', opts), /403/);
  assert.equal(f.calls.length, 1);
});
test('回数を使い切ったら落とす', () => {
  const f = fake([500, 500, 500]);
  assert.throws(() => deleteCompany(f.request, 'c2', { ...opts, tries: 3 }), /3\/3/);
});
test('消したのに一覧に残っていたら落とす', () => {
  const f = fake([200], ['c2']);
  assert.throws(() => deleteCompany(f.request, 'c2', opts), /一覧に残っている/);
});
test('一覧の返事の形が分からない時は消えたと見なさない', () => {
  const request = m => (m === 'DELETE' ? { status: 200, text: '' } : { status: 200, text: '{"data":[]}' });
  assert.throws(() => deleteCompany(request, 'c2', opts), /一覧を読めない/);
});
