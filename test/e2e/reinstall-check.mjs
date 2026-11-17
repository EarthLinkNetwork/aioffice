// 入れ直しと網なしで、図書室と知らせの中身が残り・動くことを確かめる（範囲の文書の G1・G2）
// 使い方:
//   AIO_CONTAINER=aioffice node test/e2e/reinstall-check.mjs snap <記録の file>
//     入れ直しの前に、所蔵・置いた文書・添え書きの comment・知らせの既読と未読を記録する
//   AIO_CONTAINER=aioffice node test/e2e/reinstall-check.mjs check <記録の file> [--search]
//     入れ直しの後に、2 つの plugin の見回りを流してから記録と比べる。
//     --search を付けると、置いた文書の言葉で検索して当たることも確かめる（網なしの G1）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BRIEF_MARK } from '../../plugins/library/src/lib.mjs';
import { compareStates, searchHitsDoc } from './reinstall-compare.mjs';
import { dockerSync } from './docker.mjs';

const CONTAINER = process.env.AIO_CONTAINER || 'aioffice';
const [cmd, file, flag] = process.argv.slice(2);
const log = (...a) => console.log('[reinstall check]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// container の中から本体（127.0.0.1:3101）に直に頼む
function core(method, p, body) {
  const js = `const r=await fetch('http://127.0.0.1:3101/api'+process.argv[1],{method:process.argv[2],headers:{'content-type':'application/json'},body:process.argv[3]||undefined});const t=await r.text();console.log(JSON.stringify({s:r.status,t}))`;
  const out = dockerSync(['exec', CONTAINER, 'node', '--input-type=module', '-e', js, p, method, body ? JSON.stringify(body) : ''], { encoding: 'utf8', timeout: 120000 });
  const { s, t } = JSON.parse(out.trim().split('\n').pop());
  let j = null; try { j = JSON.parse(t); } catch { j = null; }
  return { s, j, t };
}
const ok = (method, p, body) => { const r = core(method, p, body); if (r.s >= 400) throw new Error(`${method} ${p} → ${r.s} ${r.t.slice(0, 200)}`); return r.j; };
const list = x => (Array.isArray(x) ? x : x?.items || []);

function state() {
  const companies = list(ok('GET', '/companies'));
  assert.equal(companies.length, 1, `会社は 1 社のはず (${companies.length})`);
  const cid = companies[0].id, q = `companyId=${encodeURIComponent(cid)}`;
  const lib = ok('GET', `/plugins/aioffice.library/api/status?${q}`);
  const docs = ok('GET', `/plugins/aioffice.library/api/documents?${q}`).documents.map(d => d.name).sort();
  const notices = ok('GET', `/plugins/aioffice.notify/api/notices?${q}`).notices;
  let briefs = 0;
  for (const i of list(ok('GET', `/companies/${cid}/issues`))) briefs += list(ok('GET', `/issues/${i.id}/comments`)).filter(c => String(c.body || '').includes(BRIEF_MARK)).length;
  return {
    cid, chunks: lib.chunks, docs, briefs,
    read: notices.filter(n => n.readAt).map(n => n.key).sort(),
    unread: notices.filter(n => !n.readAt).map(n => n.key).sort(),
  };
}

// 見回りの口を流す（起動係の見回りと重なった 409 は待って流し直す）
async function tick(key, cid) {
  for (let n = 0; n < 30; n++) {
    const r = core('POST', `/plugins/${key}/api/tick?companyId=${encodeURIComponent(cid)}`, {});
    if (r.s < 400) return r.j;
    if (r.s !== 409) throw new Error(`${key} の見回り → ${r.s} ${r.t.slice(0, 200)}`);
    await sleep(2000);
  }
  throw new Error(`${key} の見回りが 60 秒たっても重なったまま`);
}

if (cmd === 'snap') {
  // 前の e2e が文書を消している時は 1 つ置き、読んだ知らせが無い時は 1 つ読んでから記録する
  let s = state();
  const q = `companyId=${encodeURIComponent(s.cid)}`;
  if (!s.docs.length) ok('POST', `/plugins/aioffice.library/api/documents?${q}`, { name: 'reinstall-check.md', text: '# Reinstall check\nThis file must stay after the plugin is installed again.' });
  if (!s.read.length && s.unread.length) ok('POST', `/plugins/aioffice.notify/api/notices/read?${q}`, { key: s.unread[0] });
  s = state();
  assert.ok(s.chunks > 0 && s.docs.length > 0, `所蔵と置いた文書がある状態で記録する (${s.chunks}・${s.docs.length})`);
  assert.ok(s.read.length > 0, '読んだ知らせがある状態で記録する');
  fs.writeFileSync(file, JSON.stringify(s));
  log('記録', JSON.stringify({ chunks: s.chunks, docs: s.docs.length, briefs: s.briefs, read: s.read.length, unread: s.unread.length }));
} else if (cmd === 'check') {
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cid = state().cid;
  await tick('aioffice.library', cid);
  await tick('aioffice.notify', cid);
  await tick('aioffice.library', cid); // 2 回流しても添え書きは増えない
  const after = state();
  const bad = compareStates(before, after);
  assert.deepEqual(bad, [], `入れ直しの前後の食い違い: ${bad.join(' / ')}`);
  if (flag === '--search') {
    const r = ok('GET', `/plugins/aioffice.library/api/search?companyId=${encodeURIComponent(after.cid)}&q=${encodeURIComponent(before.docs[0])}`);
    assert.ok(searchHitsDoc(r.results, before.docs[0]), `網なしで置いた文書「${before.docs[0]}」そのものが検索で当たる`);
    // 意味の近さ: 網なしでも image の中の Ollama と bge-m3 で、英語の記録を日本語の言い換えで引ける（範囲 2026-11-17 の保証 1・入れ直しで埋めた物が残る）
    const EVAL = JSON.parse(fs.readFileSync(new URL('../fixtures/library-eval.json', import.meta.url), 'utf8'));
    let sem = null;
    for (let i = 0; i < 120; i++) { sem = ok('GET', `/plugins/aioffice.library/api/status?companyId=${encodeURIComponent(after.cid)}`).semantic; if (sem?.ok && sem.backlog === 0) break; await sleep(5000); }
    assert.equal(sem?.ok, true, `網なしで意味の検索が使える（${JSON.stringify(sem)}）`);
    const x = EVAL.semantic.questions[0];
    // 起こし直した後の最初の問いは記憶を裏で読み始めるので、warming の間は問い直す
    let res = null;
    for (let i = 0; i < 30; i++) { res = ok('GET', `/plugins/aioffice.library/api/search?companyId=${encodeURIComponent(after.cid)}&q=${encodeURIComponent(x.q)}`); if (res.semanticReason !== 'warming') break; await sleep(2000); }
    assert.equal(res.semantic, true, `網なしの返事が semantic === true（${res.semanticReason}）`);
    const hits = res.results.slice(0, 5);
    assert.ok(hits.some(h => h.semanticOnly && `${h.title}\n${h.text}`.includes(x.a)), `網なしで「${x.q}」の上位 5 件に ${x.a} が意味だけで当たる（${JSON.stringify(hits.map(h => [h.title, h.cos]))}）`);
  }
  log('ok', JSON.stringify({ chunks: after.chunks, docs: after.docs.length, briefs: after.briefs, read: after.read.length, unread: after.unread.length }));
} else {
  console.error('使い方: reinstall-check.mjs snap|check <記録の file> [--search]');
  process.exit(2);
}
