// 1 つの話の読み込み・読み直し・送信（話の画面 Chat と、判断カードの画面の「この件の話」で使う・docs/design/2026-11-22-app-card-ux.md 2.3）。
// 開いた時に全部読み、返事待ちの間だけ 5 秒おきに読み直す（最長 3 分）。push で届いた返事と、前面に戻った時も読み直す。
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { ChatMessage, NotifyClient, Thread, ThreadStatus } from '../notify/client';
import { pushReloads, type PushTarget } from '../notify/push-logic';
import { lastAt, mergeMessages, nextPoll, showThinking } from './logic';

export type PushSignal = { target: PushTarget; n: number } | null;
// 話がまだ無い時の最初の発言で話を作る口（担当との新しい話・判断の件の話）
export type CreateThread = (text: string) => Promise<{ ok: true; thread: Thread } | { ok: false; message: string }>;

export function useThread({ client, bindingId, threadId: initial, waitForThread = false, push, onThread, onToast }: {
  client: NotifyClient; bindingId: string; threadId: string | null;
  waitForThread?: boolean; // 話の id を後から決める（直前の話を探す間）。決まるまで「読み終わった」にしない
  push: PushSignal; onThread?: (threadId: string, thread: Thread) => void; onToast: (m: string) => void;
}) {
  const [threadId, setThreadId] = useState<string | null>(initial);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ThreadStatus>('done');
  const [ready, setReady] = useState(!initial && !waitForThread);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [startedAt, setStartedAt] = useState(() => Date.now()); // 読み直しの 3 分を数え始めた時（開いた・送った・引いた時）
  const [missed, setMissed] = useState(0); // 読み直しが失敗した回数（次の読み直しを掛け直す合図）
  const lock = useRef(false);
  const cur = useRef({ threadId, messages });
  cur.current = { threadId, messages };

  // 外から話の id が渡された時（card に話が付いた・同じ件の話を後から知った）
  useEffect(() => { if (initial && initial !== cur.current.threadId) setThreadId(initial); }, [initial]);

  const readAll = useCallback(async (id: string) => {
    const p = await client.listMessages(bindingId, id);
    if (cur.current.threadId !== id) return;
    setMessages(p.messages); setStatus(p.status); setReady(true);
  }, [client, bindingId]);
  const readMore = useCallback(async () => {
    const id = cur.current.threadId; if (!id) return;
    const p = await client.listMessages(bindingId, id, lastAt(cur.current.messages));
    if (cur.current.threadId !== id) return;
    setMessages(m => mergeMessages(m, p.messages)); setStatus(p.status);
  }, [client, bindingId]);

  useEffect(() => {
    if (!threadId) return;
    readAll(threadId).catch(() => { onToast('話を読めませんでした。引いてもう一度'); setReady(true); });
  }, [threadId, readAll]);

  const thinking = showThinking(messages, status);
  useEffect(() => {
    if (!threadId) return;
    const wait = nextPoll(thinking, startedAt, Date.now());
    if (wait == null) return;
    const t = setTimeout(() => { readMore().catch(() => setMissed(n => n + 1)); }, wait);
    return () => clearTimeout(t);
  }, [threadId, thinking, startedAt, messages, status, missed, readMore]);

  useEffect(() => {
    if (threadId && push && pushReloads(push.target, { bindingId, threadId })) readMore().catch(() => undefined);
  }, [push]);
  useEffect(() => {
    const s = AppState.addEventListener('change', st => { if (st === 'active') readMore().catch(() => undefined); });
    return () => s.remove();
  }, [readMore]);

  const refresh = async () => {
    if (!threadId) return;
    setRefreshing(true);
    try { await readAll(threadId); setStartedAt(Date.now()); } catch { onToast('読み直せませんでした'); } finally { setRefreshing(false); }
  };

  // 送る。話が無ければ create で作る。送れたら true（入力欄を空にする合図）
  const send = async (body: string, create: CreateThread): Promise<boolean> => {
    if (!body || lock.current) return false;
    lock.current = true; setSending(true);
    try {
      const id = cur.current.threadId;
      if (!id) {
        const r = await create(body);
        if (!r.ok) { onToast(r.message); return false; }
        setStatus('waiting'); setStartedAt(Date.now());
        cur.current.threadId = r.thread.id; setThreadId(r.thread.id); onThread?.(r.thread.id, r.thread);
        return true;
      }
      const r = await client.sendMessage(bindingId, id, body);
      if (!r.ok) { onToast(r.message); return false; }
      // サーバーは発言を受けると話を返事待ちに戻す。失敗の話へ送り直した時も「考えています…」と読み直しを始める
      setMessages(m => mergeMessages(m, [r.sent])); setStatus('waiting'); setStartedAt(Date.now());
      return true;
    } finally { lock.current = false; setSending(false); }
  };

  return { threadId, setThreadId, messages, status, ready, setReady, sending, refreshing, thinking, refresh, send };
}
