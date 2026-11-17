// ① 秘書・④ 担当と話す（mock docs/mocks/app-chat-mock.html）。話 1 件 = Paperclip の課題 1 件（仕様 docs/review/2026-11-14-app-chat-spec.md）。
// 返事を待つ間は「考えています…」。返事は push か、話を開いていて返事待ちの間だけの 5 秒おきの読み直し（最長 3 分）。あとは push と引いて読み直し。
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, RefreshControl, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChatMessage, NotifyClient, Thread } from '../notify/client';
import {
  MAX_TEXT, THINKING, cardChip, dayLabel, handedNote, rulesNote, talkPlaceholder,
} from '../chat/logic';
import { useThread, type PushSignal } from '../chat/useThread';
import { useColors } from '../theme';
import { Chip, T } from '../ui';

export type { PushSignal };

const dayKey = (iso: string) => { const d = new Date(Date.parse(iso)); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

export function Chat({ client, bindingId, agentId, agentName, secretary, threadId: initial, latest, push, onThread, onToast, onCard }: {
  client: NotifyClient; bindingId: string; agentId: string; agentName: string; secretary: boolean;
  threadId: string | null; latest?: boolean; // latest: その担当との直前の話の続きを開く（下のタブ「秘書」）
  push: PushSignal; onThread: (threadId: string) => void; onToast: (m: string) => void;
  onCard?: () => void; // 札「判断の件から」を押した時: 元の判断カードを開く（docs/design/2026-11-22-app-card-ux.md 2.3）
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState('');
  const scroll = useRef<ScrollView>(null);
  const t = useThread({ client, bindingId, threadId: initial, waitForThread: !!latest, push, onToast,
    onThread: (id, th) => { setThread(th); onThread(id); } });
  const { threadId, messages, ready, sending, refreshing, thinking } = t;

  // 話の題・回した先（一覧から）。latest の時は直前の話を選ぶ
  useEffect(() => {
    let alive = true;
    if ((!latest && !initial) || !agentId) return; // 通知から開いて担当が分からない時は、題と回した先を出さない
    client.listThreads(bindingId, agentId).then(ts => {
      if (!alive) return;
      const x = latest ? ts[0] : ts.find(y => y.id === initial);
      if (x) { setThread(x); if (latest) t.setThreadId(x.id); }
      if (latest && !x) t.setReady(true); // まだ話が無い: 最初の発言で新しい話を作る
    }).catch(() => { if (alive) { onToast('話を読めませんでした。引いてもう一度'); t.setReady(true); } });
    return () => { alive = false; };
  }, [client, bindingId, agentId, initial, latest]);

  const send = async () => {
    const body = text.trim();
    if (await t.send(body, x => client.createThread(bindingId, { agentId, text: x }))) setText('');
  };

  const chip = cardChip(messages);
  const shown = chip ? messages.slice(1) : messages;
  const firstAgent = shown.find(m => m.role === 'agent')?.id;
  const lastAgent = [...shown].reverse().find(m => m.role === 'agent')?.id;

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} keyboardVerticalOffset={insets.top + 44 /* 上の帯の高さ */}>
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 4, gap: 8 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={t.refresh} />}>
        {chip ? <Pressable style={{ alignSelf: 'center' }} onPress={onCard} disabled={!onCard} accessibilityRole={onCard ? 'button' : undefined} accessibilityLabel={onCard ? `${chip}（判断カードを開く）` : chip}>
          <Chip label={onCard ? `${chip} ›` : chip} />
        </Pressable> : null}
        {shown.map((m, i) => (
          <View key={m.id} style={{ gap: 8 }}>
            {i === 0 || dayKey(shown[i - 1].at) !== dayKey(m.at) ? <T style={{ alignSelf: 'center', fontSize: 11, color: c.sub }}>{dayLabel(m.at)}</T> : null}
            <Bubble m={m} />
            {secretary && m.id === firstAgent && thread?.handedTo ? <T style={{ fontSize: 12, color: c.sub }}>{handedNote(thread.handedTo)}</T> : null}
            {!secretary && m.id === lastAgent ? <T style={{ fontSize: 12, color: c.sub }}>{rulesNote(agentName)}</T> : null}
          </View>
        ))}
        {thinking ? <View style={{ alignSelf: 'flex-start', maxWidth: '82%', backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 16, borderBottomLeftRadius: 4, paddingHorizontal: 11, paddingVertical: 8 }}>
          <T style={{ fontSize: 13, color: c.sub }}>{THINKING}</T>
        </View> : null}
        {ready && !threadId && !messages.length ? <T style={{ alignSelf: 'center', fontSize: 12, color: c.sub, paddingVertical: 24 }}>{`${agentName}に話すと、新しい話が始まります`}</T> : null}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.card, alignItems: 'flex-end' }}>
        <TextInput value={text} onChangeText={setText} multiline maxLength={MAX_TEXT} placeholder={talkPlaceholder(agentName, secretary)} placeholderTextColor={c.sub}
          accessibilityLabel={talkPlaceholder(agentName, secretary)}
          style={{ flex: 1, maxHeight: 120, borderWidth: 1, borderColor: c.line, borderRadius: 18, paddingHorizontal: 12, paddingTop: 7, paddingBottom: 7, color: c.ink, fontSize: 13, backgroundColor: c.card }} />
        <Pressable onPress={send} disabled={sending || !text.trim() || !ready} accessibilityRole="button" accessibilityLabel={sending ? '送っています' : '送る'}
          style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', opacity: sending || !text.trim() || !ready ? 0.45 : 1 }}>
          <T weight="bold" style={{ color: c.accentInk, fontSize: 15 }}>{sending ? '…' : '↑'}</T>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

export function Bubble({ m }: { m: ChatMessage }) {
  const c = useColors();
  if (m.role === 'system') return <T style={{ alignSelf: 'center', fontSize: 11, color: c.sub }}>{m.text}</T>;
  const me = m.role === 'me';
  return (
    <View style={{ alignSelf: me ? 'flex-end' : 'flex-start', maxWidth: '82%', backgroundColor: me ? c.accent : c.card, borderWidth: me ? 0 : 1, borderColor: c.line, borderRadius: 16, ...(me ? { borderBottomRightRadius: 4 } : { borderBottomLeftRadius: 4 }), paddingHorizontal: 11, paddingVertical: 8 }}>
      <T selectable style={{ fontSize: 13, lineHeight: 20, color: me ? c.accentInk : c.ink }}>{m.text}</T>
    </View>
  );
}
