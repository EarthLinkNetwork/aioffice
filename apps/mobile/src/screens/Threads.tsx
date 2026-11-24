// ② 履歴（「履歴 ›」から）: その担当との話の一覧（新しい順）。「＋ 新しい話」で新しい課題を作る（最初の発言で作る）。
import { useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView } from 'react-native';
import type { NotifyClient, Thread } from '../notify/client';
import { threadMeta } from '../chat/logic';
import { useColors } from '../theme';
import { Btn, T } from '../ui';

export function Threads({ client, bindingId, agentId, onOpen, onToast }: {
  client: NotifyClient; bindingId: string; agentId: string; onOpen: (threadId: string | null) => void; onToast: (m: string) => void;
}) {
  const c = useColors();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = async () => {
    try { setThreads(await client.listThreads(bindingId, agentId)); } catch { onToast('話の一覧を読めませんでした。引いてもう一度'); }
  };
  useEffect(() => { load(); }, [bindingId, agentId]);
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 8 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      <Btn label="＋ 新しい話" variant="primary" onPress={() => onOpen(null)} />
      {(threads ?? []).map(t => (
        <Pressable key={t.id} onPress={() => onOpen(t.id)} accessibilityRole="button"
          style={({ pressed }) => ({ backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, opacity: pressed ? 0.7 : 1 })}>
          <T weight="bold" numberOfLines={1}>{t.title}</T>
          <T style={{ fontSize: 12, color: c.sub }}>{threadMeta(t)}</T>
        </Pressable>
      ))}
      {threads && threads.length === 0 ? <T style={{ textAlign: 'center', color: c.sub, paddingVertical: 16 }}>まだ話はありません</T> : null}
      <T style={{ fontSize: 12, color: c.sub, textAlign: 'center' }}>話は 1 件ずつ Paperclip の課題として残る</T>
    </ScrollView>
  );
}
