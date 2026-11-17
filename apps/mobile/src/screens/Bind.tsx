// ⑨ 会社とつなぐ（mock の renderBind）: 会社の Paperclip で出した code を入れる → 出した本人が Paperclip で確かめるのを待つ。
// 確かめは Paperclip の側（両方向の確認・設計 2026-11-10 改）。アプリは code を渡して、状態を数秒ごとに読むだけ。
import { useEffect, useRef, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import type { BindState, NotifyClient } from '../notify/client';
import { useColors } from '../theme';
import { Btn, Sec, T } from '../ui';

export function Bind({ client, email, onDone, onToast, initialCode }: { client: NotifyClient; email: string; onDone: () => void; onToast: (m: string) => void; initialCode?: string }) {
  const c = useColors();
  const [code, setCode] = useState(initialCode ?? '');
  const [wait, setWait] = useState<{ id: string; company: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!wait) return;
    const tick = async () => {
      const st: BindState = await client.bindState(wait.id);
      if (st === 'waiting') return;
      if (timer.current) clearInterval(timer.current);
      setWait(null);
      if (st === 'bound') { onToast('つないだ。この会社の承認・判断カードが届くようになった'); onDone(); }
      else setError(st === 'rejected' ? '断られました。メールアドレスを確かめて、code を出し直してください' : '10 分で切れました。code を出し直してください');
    };
    timer.current = setInterval(tick, 3000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [wait]);

  const start = async (value: string = code) => {
    setError(null);
    const r = await client.startBind(value.trim().toUpperCase());
    if (r.ok) setWait({ id: r.bindingId, company: r.company }); else setError(r.message);
  };

  if (wait) return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 10 }} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      <Sec title="確かめを待っています">
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.warn }} />
          <T style={{ fontSize: 13, flex: 1 }}>{wait.company} の Paperclip で、code を出した人が「{email} とつなぐ」を確かめるのを待っています。</T>
        </View>
        <T style={{ fontSize: 12.5, color: c.sub }}>メールアドレスが違うと断られます。10 分で切れたら code を出し直してください。</T>
        <Btn label="やめる" onPress={() => { const id = wait.id; setWait(null); client.unbind(id).catch(() => undefined); }} />
      </Sec>
      <Sec title="つないだ後に 1 つだけ">
        <T style={{ fontSize: 12.5 }}>会社ごとの判断（選択肢つきの判断）も受けるには、Paperclip で「判断を受けるために承認する」を押します。押すまでは承認・判断カードだけが届きます。</T>
      </Sec>
    </ScrollView>
  );

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 10 }} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      <Sec title="つなぎ方">
        {['会社の Paperclip を開き、「AI Office」の画面で「スマホとつなぐ」を押す', '出てきた code を下に入れる（10 分で切れる・1 回だけ使える）', 'Paperclip の画面に出るあなたのメールアドレスを確かめて「つなぐ」を押す']
          .map((t, i) => <T key={i} style={{ fontSize: 13 }}>{`${i + 1}. ${t}`}</T>)}
      </Sec>
      {initialCode ? (
        <Sec title="QR で受けた code">
          <T style={{ fontSize: 13 }}>QR の code を下に入れた。自分が会社の Paperclip で出した code の時だけ「つなぐ」を押してください。人から送られた QR やリンクの code でつなぐと、その会社の通知がこの端末に届き、あなたのメールアドレスが相手に見えます。</T>
        </Sec>
      ) : null}
      <Sec title="code">
        <TextInput value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} textContentType="oneTimeCode" placeholder="XXXX-XXXX-XXXX" placeholderTextColor={c.sub}
          accessibilityLabel="つなぐための code"
          style={{ fontSize: 20, fontWeight: '700', letterSpacing: 2.4, textAlign: 'center', borderWidth: 1, borderColor: c.line, borderRadius: 12, paddingVertical: 12, backgroundColor: c.screen, color: c.ink, fontFamily: 'Menlo' }} />
        {error ? <T style={{ fontSize: 12.5, color: c.urgent }}>{error}</T> : null}
        <Btn variant="primary" label="つなぐ" disabled={!code.trim()} onPress={() => start()} />
      </Sec>
    </ScrollView>
  );
}
