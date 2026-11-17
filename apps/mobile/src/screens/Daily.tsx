// ⑥ 毎日の号（下のタブ）。Web の号と同じ号を、通知 API の overview の dailyTimes から出す。
import { useEffect, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView } from 'react-native';
import type { DailyTimes, NotifyClient } from '../notify/client';
import { todayMeta } from '../chat/logic';
import { DAILY_NOTE } from '../chat/labels';
import { useColors } from '../theme';
import { Sec, T } from '../ui';

const lines = (xs: string[]) => xs.map(x => `・${x}`).join('\n');

export function Daily({ client, bindingId, onEdition, onToast }: {
  client: NotifyClient; bindingId: string; onEdition: (d: DailyTimes | null) => void; onToast: (m: string) => void;
}) {
  const c = useColors();
  const [d, setD] = useState<DailyTimes | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const load = async () => {
    try { const ov = await client.overview(bindingId); setD(ov?.dailyTimes ?? null); onEdition(ov?.dailyTimes ?? null); }
    catch { onToast('号を読めませんでした。引いてもう一度'); }
    finally { setLoaded(true); }
  };
  useEffect(() => { setD(null); setLoaded(false); onEdition(null); load(); }, [bindingId]);
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 8 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      {d ? (
        <>
          <Sec>
            <T weight="bold">今日すること</T>
            <T style={{ fontSize: 12, color: c.sub }}>{todayMeta(d.today)}</T>
            {d.today.length ? <T style={{ fontSize: 13 }}>{lines(d.today)}</T> : null}
          </Sec>
          <Sec>
            <T weight="bold">新着</T>
            <T style={{ fontSize: 12, color: c.sub }}>{`${d.news.length} 件`}</T>
            {d.news.length ? <T style={{ fontSize: 13 }}>{lines(d.news.slice(0, 2)) + (d.news.length > 2 ? ' …' : '')}</T> : null}
          </Sec>
          <Sec>
            <T weight="bold">会社のできごと</T>
            <T style={{ fontSize: 13 }}>{d.events.length ? d.events.join('・') : 'まだありません'}</T>
          </Sec>
          <Pressable onPress={() => { if (d.url) Linking.openURL(d.url); }} accessibilityRole="link">
            <T style={{ fontSize: 12, color: c.sub, textAlign: 'center' }}>{DAILY_NOTE}</T>
          </Pressable>
        </>
      ) : loaded ? <T style={{ textAlign: 'center', color: c.sub, paddingVertical: 24 }}>今日の号はありません</T> : null}
    </ScrollView>
  );
}
