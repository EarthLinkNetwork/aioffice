// ③ 会社（部署ごとのサマリー → 担当）と ③-2 部署を押した時（担当の一覧）。中身は通知 API の overview と担当の一覧（agents）。
import { useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import type { AgentDirectory, ChatAgent, NotifyClient, Overview } from '../notify/client';
import { deptRows, type DeptRow } from '../chat/logic';
import { useColors, type Colors } from '../theme';
import { Avatar, Chip, Sec, T } from '../ui';

// 頭文字の丸の色（mock: 緑・紫・青・赤の順）
const avColor = (c: Colors, i: number) => [c.ok, c.sns, c.accent, c.urgent][i % 4];

export function Company({ client, bindingId, onDept, onToast }: {
  client: NotifyClient; bindingId: string; onDept: (row: DeptRow, color: number) => void; onToast: (m: string) => void;
}) {
  const c = useColors();
  const [ov, setOv] = useState<Overview | null>(null);
  const [dir, setDir] = useState<AgentDirectory | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // 読めた方だけ出す。読めなかった方は前の状態を残し、知らせを出す
  const load = async () => {
    const [o, d] = await Promise.allSettled([client.overview(bindingId), client.chatAgents(bindingId)]);
    if (o.status === 'fulfilled') setOv(o.value);
    if (d.status === 'fulfilled') setDir(d.value);
    if (o.status === 'rejected' || d.status === 'rejected') onToast('会社の様子の一部を読めませんでした。引いてもう一度');
    setLoaded(true);
  };
  useEffect(() => { setOv(null); setDir(null); setLoaded(false); load(); }, [bindingId]);
  const rows = deptRows(ov, dir);
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 8 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      {ov?.whole.summary ? <Sec><T weight="bold">全体</T><T style={{ fontSize: 13 }}>{ov.whole.summary}</T></Sec> : null}
      {rows.map((r, i) => (
        <Pressable key={r.key} onPress={() => onDept(r, i)} accessibilityRole="button"
          style={({ pressed }) => ({ backgroundColor: c.card, borderWidth: 1, borderColor: r.caution ? c.urgent : c.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', gap: 10, opacity: pressed ? 0.7 : 1 })}>
          <Avatar name={r.name} color={avColor(c, i)} />
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <T weight="bold">{r.name}</T>
              {r.working ? <Chip label={`作業中 ${r.working}`} /> : null}
              {r.caution ? <Chip label="注意" color={c.urgent} /> : null}
            </View>
            {r.caution || r.summary ? <T style={{ fontSize: 12, color: c.sub }}>{r.caution ?? r.summary}</T> : null}
          </View>
        </Pressable>
      ))}
      {loaded && !rows.length ? <T style={{ textAlign: 'center', color: c.sub, paddingVertical: 16 }}>会社の様子はまだ届いていません</T> : null}
      <T style={{ fontSize: 12, color: c.sub, textAlign: 'center' }}>部署を押すと、担当の一覧と担当ごとの話</T>
    </ScrollView>
  );
}

export function Dept({ row, color, onTalk }: { row: DeptRow; color: number; onTalk: (a: ChatAgent) => void }) {
  const c = useColors();
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 8 }}>
      {row.summary || row.caution ? (
        <Sec>
          <T weight="bold">要約</T>
          {row.summary ? <T style={{ fontSize: 13 }}>{row.summary}</T> : null}
          {row.caution ? <T style={{ fontSize: 13, color: c.urgent }}>{`注意: ${row.caution}`}</T> : null}
        </Sec>
      ) : null}
      {row.agents.map(a => (
        <Pressable key={a.id} onPress={() => onTalk(a)} accessibilityRole="button" accessibilityLabel={`${a.name}と話す`}
          style={({ pressed }) => ({ backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', gap: 10, opacity: pressed ? 0.7 : 1 })}>
          <Avatar name={a.name} color={avColor(c, color)} />
          <View style={{ flex: 1 }}>
            <T weight="bold">{a.name}</T>
            <T style={{ fontSize: 12, color: c.sub }}>{[a.blurb, '話す ›'].filter(Boolean).join('・')}</T>
          </View>
        </Pressable>
      ))}
      {!row.agents.length ? <T style={{ textAlign: 'center', color: c.sub, paddingVertical: 16 }}>この部署の担当はまだ届いていません</T> : null}
    </ScrollView>
  );
}
