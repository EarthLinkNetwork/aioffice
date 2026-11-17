// CI の runner の決まり（2026-11-17・組織の Actions の無料枠）: PR と push で GitHub の runner を使う job を作らない。
// GitHub の runner を使ってよいのは、手動の実行（workflow_dispatch）か、bench・release-ci の label の時だけの job。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const SELF = "[self-hosted, linux, x64, ci, runner-light]";

// jobs: の下の job ごとに、その本文（字下げ 4 の行まで含む）を切り出す
const jobsOf = text => {
  const lines = text.split('\n');
  const at = lines.findIndex(l => l === 'jobs:');
  assert.ok(at >= 0, 'jobs: がない');
  const jobs = {};
  let cur = null;
  for (const l of lines.slice(at + 1)) {
    const m = /^  ([\w-]+):\s*$/.exec(l);
    if (m) { cur = m[1]; jobs[cur] = []; continue; }
    if (cur && (l.startsWith('    ') || l.trim() === '')) jobs[cur].push(l);
    else if (cur && /^\S/.test(l)) cur = null;
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
};
// container は、手動の実行か、PR に label release-ci を付けた時だけ（PR の event の check だけが PR に結び付き、main の保護が数える・2026-11-18 GH006）
const gated = body => /^    if: github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'pull_request' && github\.event\.action == 'labeled' && github\.event\.label\.name == 'release-ci'\)$/m.test(body);
const usesGithub = body => /\b(ubuntu|macos|windows)-[\w.]+/.test(body);

test('workflow は package.yml と embed-bench.yml の 2 つ（増えたらこの試験に決まりを足す）', () => {
  assert.deepEqual(readdirSync(DIR).filter(f => /\.ya?ml$/.test(f)).sort(), ['embed-bench.yml', 'package.yml']);
});

test('package.yml: unit は自前の runner、container は手動の実行か release-ci の label の時だけ', () => {
  const jobs = jobsOf(readFileSync(path.join(DIR, 'package.yml'), 'utf8'));
  assert.deepEqual(Object.keys(jobs).sort(), ['container', 'unit']);
  assert.ok(jobs.unit.includes(`runs-on: ${SELF}`), 'unit が自前の runner でない');
  assert.ok(!usesGithub(jobs.unit), 'unit に GitHub の runner がある');
  assert.ok(gated(jobs.container), 'container が手動の実行か release-ci の label に限られていない');
  // PR の event では、main と合わせた commit でなく写し S（PR の head）そのものを作って試す
  assert.match(jobs.container, /- uses: actions\/checkout@v7\n        with: \{ ref: "\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}" \}/);
  assert.match(jobs.container, /TAG: ci-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
});

test('package.yml: container の段も自前の runner（amd64 は runner-docker・arm64 は aioffice-arm64）で、host の docker には run ごとに名前の違う container を 1 つだけ作り、その中の別の docker で回す（2026-11-20 予算を使い切った・持ち主の判断）', () => {
  const { container } = jobsOf(readFileSync(path.join(DIR, 'package.yml'), 'utf8'));
  assert.ok(!usesGithub(container), 'container に GitHub の runner がある');
  assert.match(container, /\{ arch: amd64, runner: '\["self-hosted","linux","x64","ci","runner-docker"\]' \}/);
  assert.match(container, /\{ arch: arm64, runner: '\["self-hosted","linux","ARM64","aioffice-arm64"\]' \}/);
  assert.match(container, /runs-on: \$\{\{ fromJSON\(matrix\.runner\) \}\}/);
  // job の container（container:）は runner が host の docker の socket を必ず渡すので使わない。host で直に docker を呼ぶ段も無い（全部 ci-isolated.sh の中）
  assert.doesNotMatch(container, /^    container:/m);
  assert.match(container, /run: exec bash test\/e2e\/ci-isolated\.sh \$\{\{ matrix\.arch \}\}/); // exec しないと取り消しの合図が script に届かない
  assert.doesNotMatch(container, /^\s+(run: )?docker /m);
  const iso = readFileSync(path.join(DIR, '..', '..', 'test', 'e2e', 'ci-isolated.sh'), 'utf8');
  // 名前は run ごとに違い、host の socket・host の path を渡さず、中の docker が host と別の daemon であることを確かめ、最後に消す
  assert.match(iso, /NAME="aioffice-ci-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{ARCH\}"/);
  assert.doesNotMatch(iso, /docker\.sock:/);
  assert.doesNotMatch(iso, /docker run[^\n]*-v [\$\/][^ ]*:/);
  assert.match(iso, /"\$inner_id" = "\$host_id"/);
  assert.match(iso, /trap cleanup EXIT/);
  // 取り消しで trap が動くよう長い exec は裏で回して wait し、SIGKILL で trap が動かなくても container は時間で自分で消える（--rm と有限の sleep）。host を取り合わないよう上限を付ける
  assert.match(iso, /run_bg docker exec -w \/w "\$NAME" bash test\/e2e\/container-stage\.sh/);
  assert.doesNotMatch(iso, /--cpus /); // 時間の枠だと中の製品から CPU の数が見えず、Ollama のスレッドが枠を取り合う
  assert.match(iso, /docker run -d --rm --init [^\n]*--cpuset-cpus "\$cpuset" --memory \d+g [^\n]*\n[^\n]* sleep (\d+) /);
  // container が自分で消える時間は job の上限より長い
  const sleepSec = Number(/ sleep (\d+) /.exec(iso)[1]);
  const jobMin = Number(/^    timeout-minutes: (\d+)/m.exec(container)[1]);
  assert.ok(sleepSec > jobMin * 60, `sleep ${sleepSec} 秒が job の上限 ${jobMin} 分より短い`);
  // 前の回の残りは、印の付いた物だけを片付ける（host のほかの container に触らない）
  assert.doesNotMatch(iso, /docker ps -aq(?! --filter label=aioffice-ci=1)/);
  assert.doesNotMatch(iso, /docker (volume|network|system|image) prune/);
});

test('container-stage.sh: 段ごとに別の shell で回し、落ちたら止まる', () => {
  const st = readFileSync(path.join(DIR, '..', '..', 'test', 'e2e', 'container-stage.sh'), 'utf8');
  assert.match(st, /bash --noprofile --norc -eo pipefail -c "\$2"/);
  assert.match(st, /exit 1; fi; \}/);
  assert.ok((st.match(/^step '/gm) || []).length >= 30, '段が少ない');
});

test('package.yml: label の event でも回り、label ごとに concurrency の組を分ける（ほかの label で回っている container を取り消さない）', () => {
  const text = readFileSync(path.join(DIR, 'package.yml'), 'utf8');
  assert.match(text, /pull_request:\n    types: \[opened, synchronize, reopened, labeled\]\n/);
  assert.match(text, /^  group: package-\$\{\{ github\.ref \}\}-\$\{\{ github\.event\.action == 'labeled' && github\.event\.label\.name \|\| 'change' \}\}$/m);
});

test('embed-bench.yml: label か手動の時だけ回り、label の時は自前の runner だけ', () => {
  const text = readFileSync(path.join(DIR, 'embed-bench.yml'), 'utf8');
  assert.match(text, /pull_request:\n    types: \[labeled\]\n/);
  assert.doesNotMatch(text, /^\s+paths:/m);
  assert.doesNotMatch(text, /^  push:/m);
  const { bench } = jobsOf(text);
  assert.match(bench, /^    if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.label\.name == 'bench'$/m);
  // 計測中の bench を、ほかの label の run が取り消さない（concurrency は job の中）
  assert.doesNotMatch(text, /^concurrency:/m);
  assert.match(bench, /^    concurrency:\n      group: embed-bench-\$\{\{ github\.ref \}\}-\$\{\{ matrix\.arch \}\}/m);
  // label の時の並び（|| の右）に GitHub の runner が無い
  const labelSide = /\|\| '(\[.*?\])'\) \}\}/.exec(bench);
  assert.ok(labelSide, 'label の時の並びが見つからない');
  const list = JSON.parse(labelSide[1]);
  assert.deepEqual(list.map(x => x.arch), ['amd64']);
  assert.deepEqual(list[0].runner, ['self-hosted', 'linux', 'x64', 'ci', 'runner-light']);
});
