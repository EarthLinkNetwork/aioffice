// wizard の状態を /data に残す（途中で落ちても続きから・各段は「あれば使う・無ければ作る」）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defaultAiLimits } from './limits.mjs';

// aiLimits: AI の使用量の上限の設定（G1・G8）。aiLimitsRun: 会社ごとの見回りの記録（前の回の時刻・running の run・最後に読めた Claude の値・Credits の基準）

export const EMPTY = () => ({ v: 1, lang: null, timeZone: null, owner: null, generation: 0, companyId: null, companyName: null, companyPrefix: null, secretaryId: null, agents: {}, codexDone: false, done: false, aiChosen: false, aiSelected: [], ais: {}, agentAi: {}, aiLimits: defaultAiLimits(), aiLimitsRun: {} });

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'state.json'), secretFile = path.join(dir, 'secret');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  let state = EMPTY(), seen = null;
  const stamp = () => { try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return null; } };
  // 別の process（aioffice-reset-owner）が書き換えたら読み直す
  const load = () => { const now = stamp(); if (now === seen) return; seen = now; try { state = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* 初回 */ } };
  load();
  const save = () => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); seen = stamp(); };
  return {
    secret,
    get: () => { load(); return state; },
    update(fn) { load(); const next = { ...state }; fn(next); state = next; save(); return state; },
    // 持ち主の登録を消す（合言葉を忘れた時の戻し方・aioffice-reset-owner から呼ぶ）
    // 持ち主を作り直す時は、メールで届ける設定（アドレス・アプリ パスワード）も消す（OFF になる・範囲 docs/review/2026-11-19-mail-notify-scope.md r3 の 12）
    resetOwner() { this.update(s => { s.owner = null; s.generation += 1; s.mail = {}; }); },
  };
}

// /data に名前つきの volume がつながっているか（container を消すとデータが消える警告のため）。Linux でない時・読めない時は null
// -v を付け忘れると、Dockerfile の VOLUME で名前なしの volume（64 桁の hex）がつながる。作り直した container からは見えなくなるので false と同じに扱う
const ANON = /\/volumes\/[0-9a-f]{64}\/_data$/;
export function volumeMounted(dataDir, mountinfo = '/proc/self/mountinfo') {
  let txt; try { txt = fs.readFileSync(mountinfo, 'utf8'); } catch { return null; }
  const want = path.resolve(dataDir);
  const line = txt.split('\n').map(l => l.split(' ')).find(f => f[4] === want);
  return !!line && !ANON.test(line[3]);
}
