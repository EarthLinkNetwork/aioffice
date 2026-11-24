// 上限の e2e で、Claude の担当を作った後は、作った直後の起こしの run が終わるのを待ってから段の値の run を回す（2026-11-21 amd64 の 3 で落ちた）。
// 担当を作る文（claudeAgent を呼ぶ const の文）が続く所の直後に await afterCreate([...]) があり、作った担当が全部入っていることを確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('limits.e2e: Claude の担当を作る文のまとまりの直後に、作った担当を全部入れた afterCreate がある', () => {
  const lines = readFileSync(new URL('./e2e/limits.e2e.mjs', import.meta.url), 'utf8').split('\n');
  const isCreate = l => /^const .*\bclaudeAgent\(/.test(l);
  let groups = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!isCreate(lines[i]) || isCreate(lines[i - 1] || '')) continue;
    const made = [];
    let j = i;
    for (; isCreate(lines[j]); j++) for (const m of lines[j].matchAll(/\b([A-Za-z_]\w*) = claudeAgent\(/g)) made.push(m[1]);
    const m = lines[j].match(/^await afterCreate\(\[([^\]]*)\]\);$/);
    assert.ok(m, `${i + 1} 行の担当（${made.join(', ')}）を作った直後に afterCreate が無い`);
    assert.deepEqual(m[1].split(',').map(s => s.trim()).sort(), made.sort(), `${i + 1} 行: afterCreate に作った担当が全部入っていない`);
    groups++;
  }
  assert.ok(groups >= 8, `まとまりの数 ${groups}`);
});

// 課題を割り当てた run を待つ時は、課題の id を渡してその課題の run だけを見る（作った直後の起こしの遅れた run を取り違えて課題を閉じると、
// 課題の run が本体の continuation_task_ownership_changed で止まり、段の形を読まない・2026-11-21 amd64 の日本語の 4）
test('limits e2e: firstRunDone・firstRunRunning は必ず課題を渡し、その課題の run だけを見る', () => {
  const src = readFileSync(new URL('./e2e/limits.e2e.mjs', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/(?<!function )\bfirstRun(?:Done|Running)\(([^)]*)\)/g)];
  assert.ok(calls.length >= 9, `呼び出しが ${calls.length} 件`);
  for (const c of calls) assert.ok(c[1].split(',').length >= 3 && c[1].split(',')[2].trim(), `課題を渡していない: ${c[0]}`);
  for (const f of ['firstRunDone', 'firstRunRunning']) {
    const body = src.slice(src.indexOf(`async function ${f}(`), src.indexOf('\n}', src.indexOf(`async function ${f}(`)));
    assert.match(body, /ofIssue\(/, `${f} が課題で絞っていない`);
  }
  // ofIssue の行を取り出し、本体の run の一覧の応答と同じ形（heartbeat.js の list: SQL の列 contextIssueId を contextSnapshot.issueId に入れ替える）の run に通す
  const line = src.split('\n').find(l => l.startsWith('const ofIssue = '));
  assert.ok(line, 'ofIssue の行がある');
  const ofIssue = new Function(`${line}\nreturn ofIssue;`)();
  const listed = (issueId, extra = {}) => ({ id: 'r1', status: 'succeeded', contextSnapshot: issueId ? { issueId, wakeReason: 'issue_assigned' } : null, ...extra });
  assert.equal(ofIssue(listed('i1'), { id: 'i1' }), true, '課題の run');
  assert.equal(ofIssue(listed('i2'), { id: 'i1' }), false, '別の課題の run');
  assert.equal(ofIssue(listed(null), 'i1'), false, '課題の無い run（作った直後の起こし）');
  assert.equal(ofIssue(listed(null, { contextIssueId: 'i1' }), 'i1'), false, 'SQL の列の名前（応答には出ない）では比べない');
  assert.throws(() => ofIssue(listed('i1'), undefined), /課題の id が無い/);
});
