// CI の決まり（範囲 docs/review/2026-11-17-public-release-scope.md の作り方 1-7・保証 4・5）:
// - public の repo なので自前の runner（self-hosted）を使わない。PR は誰でも出せるので、自前の機械で外の人のコードを動かさない。GitHub の runner は public なら無料
// - pull_request_target・workflow_run を使わない（fork の PR に書き込みの権限や秘密を渡さない）
// - container.yml（呼び出して使う workflow）には permissions を書かない（呼び出し側の権限を受け継ぐ）。ほかの workflow は上で contents: read
// - packages: write は release.yml の container の呼び出しと publish・latest の job にだけ。checkout は全部 persist-credentials: false
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const read = f => readFileSync(path.join(DIR, f), 'utf8');
const HOSTED = ['ubuntu-24.04', 'ubuntu-24.04-arm'];
// matrix の runner の値（1 つの名前・'["a","b"]' の配列・JSON の "runner":[...] のどれでも）に出てくる名前を全部返す
export const runnerValues = text => [...text.matchAll(/"?runner"?\s*:\s*('[^'\n]*'|\[[^\]\n]*\]|"[^"\n]*"|[^,}\n]+)/g)].flatMap(m => m[1].match(/[\w.-]+/g) ?? []);

// jobs: の下の job ごとに、その本文（字下げ 4 の行まで含む）を切り出す
export const jobsOf = text => {
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
// job の permissions の塊で write の種類（流れの形も拾う）
const writesIn = body => [...body.matchAll(/([\w-]+)\s*:\s*write\b/g)].map(m => m[1]);

test('workflow は 4 つで、どれも自前の runner・pull_request_target・workflow_run・write-all を使わない（増えたらこの試験に決まりを足す）', () => {
  const files = readdirSync(DIR).filter(f => /\.ya?ml$/.test(f)).sort();
  assert.deepEqual(files, ['container.yml', 'embed-bench.yml', 'package.yml', 'release.yml']);
  for (const f of files) {
    const text = read(f);
    assert.doesNotMatch(text, /self-hosted/, `${f} に自前の runner がある`);
    assert.doesNotMatch(text, /pull_request_target|workflow_run/, `${f} に pull_request_target か workflow_run がある`);
    assert.doesNotMatch(text, /write-all/, `${f} に write-all がある`);
    // 自前の runner は self-hosted と書かなくても custom の label だけで当たる。job ごとに runs-on と matrix の runner の値を取り出し、決まった形だけを許す
    for (const [name, body] of Object.entries(jobsOf(text))) {
      const runsOn = [...body.matchAll(/^    runs-on:\s*(.+)$/gm)].map(m => m[1].trim());
      const usesWf = /^    uses: \.\/\.github\/workflows\/[\w-]+\.yml$/m.test(body);
      // job の段の uses は、この repo の中の workflow だけ（外の再利用の workflow を使わない）
      assert.doesNotMatch(body.replace(/^    uses: \.\/\.github\/workflows\/[\w-]+\.yml$/m, ''), /^    uses:/m, `${f}:${name} が外の workflow を使う`);
      assert.ok(runsOn.length === 1 || (runsOn.length === 0 && usesWf), `${f}:${name} の runs-on が 1 つでない`);
      for (const v of runsOn) assert.ok(HOSTED.includes(v) || v === '${{ matrix.runner }}', `${f}:${name}: runs-on に許さない値「${v}」`);
      const fromMatrix = runnerValues(body);
      for (const v of fromMatrix) assert.ok(HOSTED.includes(v), `${f}:${name}: matrix の runner に許さない値「${v}」`);
      // runs-on が matrix の runner なら、その job の中に値が書いてあること（fromJSON(vars.X) などで外から入れさせない）
      if (runsOn.includes('${{ matrix.runner }}')) assert.ok(fromMatrix.length > 0, `${f}:${name}: matrix の runner の値が job の中に無い`);
      // checkout は token を git の設定に残さない
      for (const m of body.matchAll(/- uses: actions\/checkout@v\d+\n((?:          .*\n|        with:.*\n)*)/g)) assert.match(m[0], /persist-credentials: false/, `${f}:${name} の checkout に persist-credentials: false が無い`);
    }
  }
});

test('権限: container.yml は permissions を書かず、ほかは上で contents: read だけ。packages: write は release.yml の container・publish・latest の job にだけ', () => {
  assert.doesNotMatch(read('container.yml'), /^\s*permissions\s*:/m);
  for (const f of ['package.yml', 'embed-bench.yml', 'release.yml']) {
    const text = read(f);
    const top = text.slice(0, text.indexOf('\njobs:'));
    assert.match(top, /^permissions:\n  contents: read\n(?!  )/m, `${f} の上の permissions が contents: read だけでない`);
    assert.deepEqual(writesIn(top), [], `${f} の上に write がある`);
    for (const [name, body] of Object.entries(jobsOf(text))) {
      const w = [...new Set(writesIn(body))];
      const allowed = f === 'release.yml' && ['container', 'publish', 'latest'].includes(name);
      assert.deepEqual(w, allowed ? ['packages'] : [], `${f}:${name} の書き込みの権限が違う`);
    }
  }
});

test('package.yml: PR と main で unit と container の段（container.yml を publish なしで）を回す', () => {
  const text = read('package.yml');
  assert.match(text, /^on:\n  pull_request:\n    types: \[opened, synchronize, reopened\]\n  push:\n    branches: \[main\]\n  workflow_dispatch:\n[a-z]/m);
  const jobs = jobsOf(text);
  assert.deepEqual(Object.keys(jobs).sort(), ['package', 'unit']);
  assert.match(jobs.unit, /^    runs-on: ubuntu-24\.04$/m);
  assert.match(jobs.package, /^    uses: \.\/\.github\/workflows\/container\.yml\n    with:\n      publish: false$/m);
});

test('container.yml: amd64 と arm64 で ci-isolated.sh を回し、publish の時だけ、試した image を版がまだ無い時に :<版>-<arch> で push する', () => {
  const text = read('container.yml');
  assert.match(text, /^on:\n  workflow_call:\n/m);
  const { container } = jobsOf(text);
  assert.match(container, /\{ arch: amd64, runner: ubuntu-24\.04 \}/);
  assert.match(container, /\{ arch: arm64, runner: ubuntu-24\.04-arm \}/);
  // PR の event では、main と合わせた commit でなく PR の head そのものを作って試す
  assert.match(container, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(container, /TAG: ci-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(container, /run: exec bash test\/e2e\/ci-isolated\.sh \$\{\{ matrix\.arch \}\}/); // exec しないと取り消しの合図が script に届かない
  assert.doesNotMatch(container, /^    container:/m); // job の container は runner が host の docker の socket を渡すので使わない
  // 版を出す時は埋め込みの部品の cache を使わない
  assert.match(container, /- name: 埋め込みの部品の cache\n        if: \$\{\{ !inputs\.publish \}\}/);
  // push は publish の時だけ。作り直さず試した image（:ci-<sha>）に版の tag を付け、ログインの後に版がまだ無いことを確かめてから
  const push = container.slice(container.indexOf('- name: 試験を通した image を push する'));
  assert.match(push, /^        if: \$\{\{ inputs\.publish \}\}$/m);
  assert.doesNotMatch(push, /docker build\s/);
  assert.match(push, /docker tag "\$IMAGE:\$TAG" "\$IMAGE:\$VERSION-\$ARCH"/);
  assert.ok(push.indexOf('docker login') < push.indexOf('imagetools inspect') && push.indexOf('imagetools inspect') < push.indexOf('docker push'), 'login → 版が無いことの確かめ → push の順でない');
  assert.match(push, /docker logout ghcr\.io/);
  // docker build は ci-isolated.sh（の中の container-stage.sh）の中だけ
  assert.doesNotMatch(container.slice(0, container.indexOf('- name: 試験を通した image を push する')), /^\s+(run: )?docker /m);
});

test('ci-isolated.sh: 自前の runner では隔てた container の中で、GitHub の runner では host で直に回す', () => {
  const iso = readFileSync(path.join(DIR, '..', '..', 'test', 'e2e', 'ci-isolated.sh'), 'utf8');
  // GitHub の runner の分岐は、前の版の source と埋め込みの部品を $RUNNER_TEMP に置いてから段を exec する
  const hosted = iso.slice(iso.indexOf('if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]; then'), iso.indexOf('\nfi\n') + 4);
  assert.match(hosted, /tar -C "\$RUNNER_TEMP\/old-src" -xf "\$RUNNER_TEMP\/old-src\.tar"/);
  assert.match(hosted, /fetch-embed\.sh "\$ARCH" "\$D"/);
  assert.match(hosted, /exec bash test\/e2e\/container-stage\.sh/);
  // 自前の runner の側: 名前は run ごとに違い、host の socket・host の path を渡さず、中の docker が host と別の daemon であることを確かめ、最後に消す
  assert.match(iso, /NAME="aioffice-ci-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{ARCH\}"/);
  assert.doesNotMatch(iso, /docker\.sock:/);
  assert.doesNotMatch(iso, /docker run[^\n]*-v [\$\/][^ ]*:/);
  assert.match(iso, /"\$inner_id" = "\$host_id"/);
  assert.match(iso, /trap cleanup EXIT/);
  assert.match(iso, /run_bg docker exec -w \/w "\$NAME" bash test\/e2e\/container-stage\.sh/);
  assert.doesNotMatch(iso, /--cpus /);
  assert.doesNotMatch(iso, /docker ps -aq(?! --filter label=aioffice-ci=1)/);
  assert.doesNotMatch(iso, /docker (volume|network|system|image) prune/);
  // 前の版の source は段の中で $RUNNER_TEMP/old-src から読む（決め打ちの /rt を使わない）
  const st = readFileSync(path.join(DIR, '..', '..', 'test', 'e2e', 'container-stage.sh'), 'utf8');
  assert.doesNotMatch(st, /\/rt\//);
});

test('container-stage.sh: 段ごとに別の shell で回し、落ちたら止まる', () => {
  const st = readFileSync(path.join(DIR, '..', '..', 'test', 'e2e', 'container-stage.sh'), 'utf8');
  assert.match(st, /bash --noprofile --norc -eo pipefail -c "\$2"/);
  assert.match(st, /exit 1; fi; \}/);
  assert.ok((st.match(/^step '/gm) || []).length >= 30, '段が少ない');
  // release はこの段の後に :ci-<sha> をそのまま push する。その tag を付けるのは最初の build の 1 回だけ（派生の image は別の名前・試した物を上書きしない）
  assert.equal((st.match(/-t "ghcr\.io\/earthlinknetwork\/aioffice:\$\{TAG\}"/g) || []).length, 1);
  // attestation を付けない（付くと :<版>-<arch> が index になり、publish の arch ごとの digest の照合が必ず落ちる）
  assert.match(st, /docker build --provenance=false --sbom=false [^\n]*-t "ghcr\.io\/earthlinknetwork\/aioffice:\$\{TAG\}"/);
  assert.doesNotMatch(st, /docker tag [^\n]*aioffice:\$\{TAG\}/);
  assert.doesNotMatch(st, /docker (rmi|image rm)[^\n]*aioffice:\$\{TAG\}/);
});

test('embed-bench.yml: label か手動の時だけ回り、label の時は amd64 だけ', () => {
  const text = read('embed-bench.yml');
  assert.match(text, /pull_request:\n    types: \[labeled\]\n/);
  assert.doesNotMatch(text, /^\s+paths:/m);
  assert.doesNotMatch(text, /^  push:/m);
  const { bench } = jobsOf(text);
  assert.match(bench, /^    if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.label\.name == 'bench'$/m);
  assert.doesNotMatch(text, /^concurrency:/m);
  assert.match(bench, /^    concurrency:\n      group: embed-bench-\$\{\{ github\.ref \}\}-\$\{\{ matrix\.arch \}\}/m);
  const labelSide = /\|\| '(\[.*?\])'\) \}\}/.exec(bench);
  assert.ok(labelSide, 'label の時の並びが見つからない');
  const list = JSON.parse(labelSide[1]);
  assert.deepEqual(list.map(x => x.arch), ['amd64']);
  assert.equal(list[0].runner, 'ubuntu-24.04');
});

test('release.yml: 版の tag の時だけ回り、gate → container（publish）→ publish → smoke（承認）→ latest の順', () => {
  const text = read('release.yml');
  // on: の塊は push の tags の 1 行だけ。取り消しを付けない
  assert.match(text, /^on:\n  push:\n    tags: \['v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\]\n[a-z]/m);
  assert.doesNotMatch(text, /cancel-in-progress: true/);
  const jobs = jobsOf(text);
  assert.deepEqual(Object.keys(jobs).sort(), ['container', 'gate', 'latest', 'publish', 'smoke']);
  // gate: tag の形と、tag の commit が main にあること
  assert.match(jobs.gate, /git merge-base --is-ancestor "\$GITHUB_SHA" FETCH_HEAD/);
  assert.match(jobs.container, /^    needs: gate$/m);
  assert.match(jobs.container, /^    uses: \.\/\.github\/workflows\/container\.yml\n    with:\n      publish: true\n      version: \$\{\{ needs\.gate\.outputs\.version \}\}$/m);
  // publish: 版がまだ無いことを確かめ、index の arch ごとの digest が試して push した物と同じこと
  assert.match(jobs.publish, /^    needs: \[gate, container\]$/m);
  assert.match(jobs.publish, /はもう出ている/);
  assert.match(jobs.publish, /の digest が違う/);
  assert.doesNotMatch(jobs.publish, /latest/);
  // smoke: release の承認の後、ログインせずに index の digest で取り、RUN.txt の行で起動して英語の wizard を通す
  assert.match(jobs.smoke, /^    needs: \[gate, publish\]$/m);
  assert.match(jobs.smoke, /^    environment: release$/m);
  assert.match(jobs.smoke, /docker pull "\$IMAGE@\$DIGEST"/);
  assert.doesNotMatch(jobs.smoke, /docker login/);
  assert.match(jobs.smoke, /node test\/e2e\/run-line\.mjs start "\$VERSION"/);
  assert.match(jobs.smoke, /\[ "\$got" = "\$DIGEST" \]/); // 利用者が打つ :<版> が試した index を指す
  assert.match(jobs.smoke, /AIO_LANG=en [^\n]*launcher-wizard\.e2e\.mjs/);
  // latest: smoke の後、版によらず 1 つの group で、自分の版が ghcr の版の中で一番新しい時だけ
  assert.match(jobs.latest, /^    needs: \[gate, publish, smoke\]$/m);
  // latest は smoke が試した index の digest から付ける（版の tag からは付けない）
  assert.match(jobs.latest, /imagetools create -t "\$IMAGE:latest" "\$IMAGE@\$DIGEST"/);
  assert.doesNotMatch(jobs.latest, /-t "\$IMAGE:latest" "\$IMAGE:/);
  // 版がもう出ているかの確かめは、読めない時に「無い」と読まない
  for (const t of [text, read('container.yml')]) assert.match(t, /grep -qiE 'not found\|manifest unknown' \|\| \{/);
  assert.match(jobs.latest, /^    concurrency:\n      group: release-latest\n      cancel-in-progress: false$/m);
  assert.match(jobs.latest, /tags\/list/);
  assert.match(jobs.latest, /if \[ "\$top" != "\$VERSION" \]; then [^\n]*exit 0; fi/);
  // 使う action は actions/checkout と setup-node だけ
  const uses = [...text.matchAll(/uses: ([^\s@]+)@/g)].map(m => m[1]);
  assert.deepEqual([...new Set(uses)].sort(), ['actions/checkout', 'actions/setup-node']);
});
