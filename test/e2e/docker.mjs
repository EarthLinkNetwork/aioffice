// e2e から docker を呼ぶ共有の口。container の中の process が起動できなかった時（OCI の exec の失敗）だけ、間を置いてやり直す
// なぜ: 2026-11-22 amd64 の limits の e2e が「OCI runtime exec failed: … read init-p: connection reset by peer」（exit 126）で落ちた。
// runner の docker の一時的な失敗で、試験の判定ではない。この失敗では中のコマンドが始まっていないので、やり直しても操作は重ならない。
// それ以外の失敗（コマンドの 0 でない終わり・時間切れ）はやり直さず、そのまま投げる
import { execFileSync } from 'node:child_process';

// exec の起動の一時的な失敗の文だけ（permission denied・executable file not found のような毎回同じになる失敗は拾わない・レビュー P3-1）
export const NOT_STARTED = /OCI runtime exec failed[\s\S]*(?:read init-p|connection reset by peer|broken pipe|unexpected EOF)/;
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function notStarted(e, args = ['exec']) {
  return args[0] === 'exec' && e?.status === 126 && NOT_STARTED.test(`${e.stdout || ''}${e.stderr || ''}${e.message || ''}`);
}

export function dockerSync(args, opts = {}, { tries = 4, waitMs = 2000, run = execFileSync, sleep = sleepSync } = {}) {
  for (let i = 1; ; i++) {
    try { return run('docker', args, opts); } catch (e) {
      if (i >= tries || !notStarted(e, args)) throw e; // run・build などはやり直さない（作った後の失敗で名前の衝突になり原因が隠れる・レビュー P3-2）
      console.log(`[docker] exec が起動しなかった（${i}/${tries}）。${waitMs}ms 後にやり直す`);
      sleep(waitMs);
    }
  }
}
