// ⑦ 設定（mock の renderSettings）。段 1 の範囲: 通知（承認・判断カード）・静かな時間・オフィス・つないでいる会社・アカウント。
// まとめの朝の 1 通・外の仕組みの判断待ち・72 時間の催促はサーバーの adapter と一緒に段 2、Face ID は後の版（設計の段階の表）。
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import type { Binding, Me, NotifyClient, Prefs } from '../notify/client';
import { useColors } from '../theme';
import { Btn, Sec, T } from '../ui';

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  const c = useColors();
  return (
    <Pressable onPress={() => onChange(!on)} accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={label}
      style={{ width: 42, height: 24, borderRadius: 12, backgroundColor: on ? c.ok : c.line, justifyContent: 'center', paddingHorizontal: 3 }}>
      <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff', alignSelf: on ? 'flex-end' : 'flex-start' }} />
    </Pressable>
  );
}

function Row({ label, sub, right, last }: { label: string; sub?: string; right: ReactNode; last?: boolean }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: last ? 0 : 1, borderBottomColor: c.line }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={{ fontSize: 13 }}>{label}</T>
        {sub ? <T style={{ fontSize: 11.5, color: c.sub }}>{sub}</T> : null}
      </View>
      {right}
    </View>
  );
}

export function Settings({ client, me, onBind, onSignOut, onToast }: { client: NotifyClient; me: Me; onBind: () => void; onSignOut: () => void; onToast: (m: string) => void }) {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [bindings, setBindings] = useState<Binding[]>([]);
  // 読めた方だけ出す。読めなかった方は前の状態を残し、知らせを出す
  const load = async (after?: string) => {
    const [p, b] = await Promise.allSettled([client.prefs(), client.listBindings()]);
    if (p.status === 'fulfilled') setPrefs(p.value);
    if (b.status === 'fulfilled') setBindings(b.value);
    if (p.status === 'rejected' || b.status === 'rejected') onToast(`${after ? after + '。' : ''}設定の一部を読めませんでした。開き直してもう一度`);
  };
  useEffect(() => { load(); }, []);
  const save = async (p: Prefs) => { setPrefs(p); await client.setPrefs(p); };
  const unbind = async (b: Binding) => {
    const r = await client.unbind(b.id);
    const msg = r.ok ? `${b.company} を外した。この会社の件はこの端末に届かなくなる` : r.message;
    if (r.ok) setBindings(bs => bs.filter(x => x.id !== b.id)); // 読み直しが失敗しても、外した会社は一覧から消す
    onToast(msg); load(msg);
  };
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 10 }}>
      {prefs ? (
        <Sec title="通知">
          <Row label="承認・送信の承認" sub="重要。静かな時間でも鳴る" right={<Switch label="承認・送信の承認" on={prefs.approvals} onChange={v => save({ ...prefs, approvals: v })} />} />
          <Row label="判断カード" sub="選択肢つきの判断" last right={<Switch label="判断カード" on={prefs.decisions} onChange={v => save({ ...prefs, decisions: v })} />} />
        </Sec>
      ) : null}
      {prefs ? <Sec title="静かな時間"><Row label={`${prefs.quiet.from}〜${prefs.quiet.to}`} last right={<T style={{ fontSize: 13 }}>重要だけ鳴らす</T>} /></Sec> : null}
      <Sec title="オフィス"><Row label="見るオフィス" last right={<T style={{ fontSize: 13 }}>見る権限のある会社から選ぶ</T>} /></Sec>
      <Sec title="つないでいる会社">
        {bindings.map(b => (
          <Row key={b.id} label={`${b.company} の Paperclip`}
            sub={b.decisions === 'approved' ? `判断も受ける（承認済み${b.keyDaysLeft != null ? `・あと ${b.keyDaysLeft} 日で自動で更新` : ''}）` : '承認・判断カードは受ける。会社ごとの判断は未承認'}
            right={<Btn small label="外す" onPress={() => unbind(b)} />} />
        ))}
        <Btn label="＋ 会社とつなぐ" onPress={onBind} />
      </Sec>
      <Sec title="アカウント">
        <Row label={me.email} sub={`${me.provider} でサインイン`} last right={<Btn small label="サインアウト" onPress={onSignOut} />} />
      </Sec>
    </ScrollView>
  );
}
