// ③ 送信の承認・④ 判断カード（mock の renderSend・renderDecide）。card の種類で出し分ける。
// 段 1 の範囲: 要約・推奨・中身の欄・リンク・承認／却下（却下は理由）・選択肢と入力欄で決める。
// Face ID は後の版（設計の段階の表）。外への送信・お金・取り消せない件は確かめの画面を挟む。
// ⑤「決められない — 担当と話す」: 件を作った担当との話。カードの画面の下に「この件の話」を出し、そこで書ける。全部は話の画面で読む。
// 2 回目からは同じ話の続きを開く（docs/design/2026-11-22-app-card-ux.md 2.3）。どのカードにも選択肢の外の終わらせ方がある（2.4）。
import { useRef, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, TextInput, View } from 'react-native';
import { commonActions, isGuarded, sectionTitle, shownSummary, type Card, type CardOption, type CardSection } from '../card';
import { DEFAULT_ASK, MAX_TEXT, THINKING, isCardStart } from '../chat/logic';
import { useThread, type CreateThread, type PushSignal } from '../chat/useThread';
import { choiceOptions, choiceStep } from '../decide';
import type { NotifyClient } from '../notify/client';
import { useColors } from '../theme';
import { Btn, Opt, Sec, Sheet, T } from '../ui';
import { Bubble } from './Chat';

type Values = { note?: string; inputs?: Record<string, string> };
type ActResult = { ok: true } | { ok: false; message: string };
type OnAct = (actionId: string, v?: Values) => Promise<ActResult>;

// 話す相手と、この件の話（あれば）。start: 最初の発言で件の中身つきの話を作る。openFull: 話の画面を開く（話が無ければ作ってから）
export type Talk = {
  name: string; client: NotifyClient; bindingId: string; threadId: string | null; push: PushSignal;
  start: CreateThread; onStarted: (threadId: string) => void; openFull: (threadId: string | null) => Promise<void>; onToast: (m: string) => void;
};

export function Detail({ card, onAct, onBack, onClose, talk }: { card: Card; onAct: OnAct; onBack: () => void; onClose?: () => Promise<void>; talk?: Talk }) {
  if (card.kind === 'notice') return <Notice card={card} onBack={onBack} onClose={onClose} talk={talk} />;
  const isChoice = card.kind === 'decision' || card.kind === 'interaction';
  return isChoice ? <Choice card={card} onAct={onAct} talk={talk} /> : <Approval card={card} onAct={onAct} talk={talk} />;
}

// 一番上: 「会社 · 担当」と、件の状態（未解決・話の結論・最新にしています）
function Head({ card }: { card: Card }) {
  const c = useColors();
  const st = card.status;
  if (!card.from && !st) return null;
  const tone = st?.state === 'talked' ? c.accent : st?.state === 'refreshing' ? c.sub : c.urgent;
  return (
    <View style={{ gap: 4 }}>
      {card.from ? <T style={{ fontSize: 12, color: c.sub }}>{card.from}</T> : null}
      {st ? <View style={{ alignSelf: 'flex-start', borderWidth: 1, borderColor: tone, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
        <T weight="bold" style={{ fontSize: 12, color: tone }}>{st.text}</T>
      </View> : null}
    </View>
  );
}

// ⑤ 担当と話す: 話があればその続き、無ければ件の中身つきで新しい話を作って、話の画面を開く
function TalkButton({ talk, label }: { talk?: Talk; label?: string }) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  if (!talk) return null;
  const press = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await talk.openFull(talk.threadId); } finally { lock.current = false; setBusy(false); }
  };
  return <Btn variant="primary" label={busy ? '話を開いています…' : label ?? (talk.threadId ? `${talk.name}との話を全部開く` : '決められない — 担当と話す')} disabled={busy} onPress={press} />;
}

// この件の話（カードの画面に埋め込む）: 直近の発言と入力欄。全部は「話を全部開く」で話の画面へ
const RECENT = 6;
function CardTalk({ talk }: { talk?: Talk }) {
  const c = useColors();
  const [text, setText] = useState('');
  if (!talk) return null;
  return <CardTalkBody talk={talk} text={text} setText={setText} c={c} />;
}
function CardTalkBody({ talk, text, setText, c }: { talk: Talk; text: string; setText: (t: string) => void; c: ReturnType<typeof useColors> }) {
  const t = useThread({ client: talk.client, bindingId: talk.bindingId, threadId: talk.threadId, push: talk.push, onToast: talk.onToast, onThread: id => talk.onStarted(id) });
  // 最初の発言（件の中身つき）は、自分が書いた一言（最後の段落）だけを出す。一言が無ければ出さない
  const shown = t.messages.flatMap((m, i) => {
    if (i !== 0 || m.role !== 'me' || !isCardStart(m.text)) return [m];
    const said = m.text.split('\n\n').pop()?.trim() ?? '';
    return said && said !== DEFAULT_ASK ? [{ ...m, text: said }] : [];
  }).slice(-RECENT);
  const send = async () => { if (await t.send(text.trim(), talk.start)) setText(''); };
  return (
    <Sec title={`この判断の話（${talk.name}）`}>
      <View style={{ gap: 8 }}>
        {!t.threadId ? <T style={{ fontSize: 12, color: c.sub }}>{`ここに書くと、判断の中身を添えて${talk.name}との話が始まります。決まったら、上で選んでください。`}</T> : null}
        {t.threadId && !t.ready ? <T style={{ fontSize: 12, color: c.sub }}>読んでいます…</T> : null}
        {shown.map(m => <Bubble key={m.id} m={m} />)}
        {t.thinking ? <T style={{ fontSize: 12.5, color: c.sub }}>{THINKING}</T> : null}
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-end' }}>
          <TextInput value={text} onChangeText={setText} multiline maxLength={MAX_TEXT} placeholder={`${talk.name}に書く（キーボードのマイクで話して書ける）`} placeholderTextColor={c.sub}
            accessibilityLabel={`${talk.name}に書く`}
            style={{ flex: 1, minHeight: 38, maxHeight: 120, borderWidth: 1, borderColor: c.line, borderRadius: 18, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, color: c.ink, fontSize: 13, backgroundColor: c.screen }} />
          <Pressable onPress={send} disabled={t.sending || !text.trim()} accessibilityRole="button" accessibilityLabel={t.sending ? '送っています' : '送る'}
            style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', opacity: t.sending || !text.trim() ? 0.45 : 1 }}>
            <T weight="bold" style={{ color: c.accentInk, fontSize: 15 }}>{t.sending ? '…' : '↑'}</T>
          </Pressable>
        </View>
        {t.threadId ? <Btn label="話を全部開く ›" onPress={() => talk.openFull(t.threadId)} /> : null}
      </View>
    </Sec>
  );
}

// ⑩ お知らせ（mock の renderNotice）: 要約・すること（番号つき）・元を開く・あとで（受信箱に戻る。承認するまで残る）
function Notice({ card, onBack, onClose, talk }: { card: Card; onBack: () => void; onClose?: () => Promise<void>; talk?: Talk }) {
  const c = useColors();
  const open = card.sections.find(s => s.url)?.url;
  const [closing, setClosing] = useState(false);
  // 閉じてよいのは、翌日また出る形（日付つき）のお知らせだけ（古い plugin のお知らせを閉じると二度と出ないため）
  const canClose = !!onClose && typeof card.day === 'string';
  const close = async () => { if (!canClose || !onClose || closing) return; setClosing(true); try { await onClose(); } finally { setClosing(false); } };
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 140, gap: 10 }} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
        <Head card={card} />
        {shownSummary(card) ? <Sec title="要約"><T>{shownSummary(card)}</T></Sec> : null}
        {card.sections.map((s, i) => (
          <Sec key={i} title={sectionTitle(s)}>
            {s.text.split('\n').map((line, k) => <T key={k} style={{ fontSize: 13 }}>{`${k + 1}. ${line}`}</T>)}
          </Sec>
        ))}
      </ScrollView>
      <ActionBar>
        {open ? <Btn variant="primary" label={open.label} onPress={() => Linking.openURL(open.href)} /> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {canClose ? <Btn style={{ flex: 1 }} label={closing ? '閉じています…' : '閉じる'} disabled={closing} onPress={close} /> : <Btn style={{ flex: 1 }} label="あとで" onPress={onBack} />}
          {talk ? <View style={{ flex: 1 }}><TalkButton talk={talk} label={`${talk.name}と話す`} /></View> : null}
        </View>
        <T style={{ fontSize: 11.5, color: c.sub, textAlign: 'center' }}>{canClose ? '閉じても、承認するまでは翌日また出ます' : 'お知らせは承認するまで受信箱に残る'}</T>
      </ActionBar>
    </View>
  );
}

function Kv({ fields }: { fields: { label: string; value: string }[] }) {
  const c = useColors();
  return (
    <View style={{ gap: 2 }}>
      {fields.map(f => (
        <View key={f.label} style={{ flexDirection: 'row', gap: 8 }}>
          <T style={{ fontSize: 12.5, color: c.sub, width: 63 }}>{f.label}</T>
          <T selectable style={{ fontSize: 12.5, flex: 1 }}>{f.value}</T>
        </View>
      ))}
    </View>
  );
}

function SectionView({ s }: { s: CardSection }) {
  const c = useColors();
  const pre = s.kind === 'outgoing' || s.kind === 'original';
  return (
    <Sec title={sectionTitle(s)}>
      {s.fields?.length ? <Kv fields={s.fields} /> : null}
      {pre
        ? <View style={{ backgroundColor: c.screen, borderWidth: 1, borderColor: c.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 }}><T selectable style={{ fontSize: 12.5, lineHeight: 20 }}>{s.text}</T></View>
        : <T style={s.kind === 'caution' ? undefined : { fontSize: 12.5 }}>{s.text}</T>}
      {s.url ? <Btn label={s.url.label} onPress={() => Linking.openURL(s.url!.href)} /> : null}
    </Sec>
  );
}

function Body({ card }: { card: Card }) {
  return (
    <>
      <Head card={card} />
      {shownSummary(card) ? <Sec title="要約"><T>{shownSummary(card)}</T></Sec> : null}
      {card.recommendation ? <Sec title="AI の推奨" variant="rec"><T>{card.recommendation}</T></Sec> : null}
      {card.sections.map((s, i) => <SectionView key={i} s={s} />)}
      {card.links.map(l => <Btn key={l.url} label={l.label} onPress={() => Linking.openURL(l.url)} />)}
    </>
  );
}

const ActionBar = ({ children }: { children: ReactNode }) => {
  const c = useColors();
  return <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 12, backgroundColor: c.screen + 'f2', gap: 8 }}>{children}</View>;
};

function Approval({ card, onAct, talk }: { card: Card; onAct: OnAct; talk?: Talk }) {
  const c = useColors();
  const [sheet, setSheet] = useState<null | 'confirm' | 'reject'>(null);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null); // シートの中に出す失敗の文
  const lock = useRef(false); // 同じフレームの二度押しも止める
  const open = (k: 'confirm' | 'reject') => { setErr(null); setSheet(k); };
  const run = async (a: string, v?: Values) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setErr(null);
    try { const r = await onAct(a, v); if (r.ok) setSheet(null); else setErr(r.message); } finally { lock.current = false; setBusy(false); }
  };
  const to = card.sections.find(s => s.kind === 'outgoing')?.fields?.find(f => f.label === '宛先')?.value;
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: talk ? 190 : 140, gap: 10 }} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"><Body card={card} /><CardTalk talk={talk} /></ScrollView>
      <ActionBar>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn style={{ flex: 1 }} label="却下する" variant="danger" onPress={() => open('reject')} />
          <Btn style={{ flex: 1 }} label={busy ? '送っています…' : '承認する'} variant="primary" onPress={() => (isGuarded(card) ? open('confirm') : run('approve'))} disabled={busy} />
        </View>
        {talk ? <TalkButton talk={talk} label={talk.threadId ? `${talk.name}との話を開く` : `決められない — ${talk.name}と話す`} /> : null}
      </ActionBar>
      <Sheet visible={sheet === 'confirm'} onClose={() => setSheet(null)}>
        <T weight="bold" style={{ fontSize: 15 }}>{card.risk === 'external-send' ? `自分の名前で${to ? ` ${to} に` : ''}送ります` : card.risk === 'money' ? 'お金がかかる判断を承認します' : '取り消せない判断を承認します'}</T>
        <T style={{ color: c.sub, fontSize: 12.5 }}>全文を確かめてから承認してください</T>
        {err ? <T style={{ color: c.urgent, fontSize: 12.5 }}>{err}</T> : null}
        <Btn label="承認する" variant="primary" disabled={busy} onPress={() => run('approve')} />
        <Btn label="やめる" onPress={() => setSheet(null)} />
      </Sheet>
      <Sheet visible={sheet === 'reject'} onClose={() => setSheet(null)}>
        <T weight="bold" style={{ fontSize: 15 }}>却下の理由（担当に返す）</T>
        {err ? <T style={{ color: c.urgent, fontSize: 12.5 }}>{err}</T> : null}
        <TextInput value={why} onChangeText={setWhy} multiline placeholder="例: 料金の段落を消して出し直して（キーボードのマイクで話して書ける）" placeholderTextColor={c.sub}
          style={{ minHeight: 70, maxHeight: 160, borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 8, backgroundColor: c.screen, color: c.ink, fontSize: 13, textAlignVertical: 'top' }} />
        <Btn label={busy ? '送っています…' : why.trim() ? '却下する' : '理由を書くと送れます'} variant="danger" disabled={busy || !why.trim()} onPress={() => run('reject', { note: why.trim() })} />
        <Btn label="やめる" onPress={() => setSheet(null)} />
      </Sheet>
    </View>
  );
}

// 選択肢を 1 回押したら送る（2026-11-13 の決定）。理由が要る操作は理由の欄、外への送信・お金・取り消せない件は確かめを挟む。
// 送っている間は押した選択肢に「送っています…」を出し、ほかは押せなくする。失敗は App が知らせに出す。
function Choice({ card, onAct, talk }: { card: Card; onAct: OnAct; talk?: Talk }) {
  const c = useColors();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ step: 'note' | 'confirm'; opt: CardOption } | null>(null);
  const [why, setWhy] = useState('');
  const missing = (card.inputs ?? []).some(i => i.required && !inputs[i.id]?.trim());
  const opts = choiceOptions(card);
  const common = commonActions(card);
  const [err, setErr] = useState<string | null>(null); // シートの中に出す失敗の文（知らせはシートの下に隠れる）
  const lock = useRef(false); // 同じフレームの二度押しも止める
  const send = async (id: string, v: Values) => {
    if (lock.current) return;
    lock.current = true; setSending(id); setErr(null);
    try { const r = await onAct(id, v); if (r.ok) setSheet(null); else setErr(r.message); } finally { lock.current = false; setSending(null); }
  };
  const press = (o: CardOption) => {
    if (lock.current) return;
    const step = choiceStep(card, o.id);
    if (step === 'send') send(o.id, { inputs });
    else { setWhy(''); setErr(null); setSheet({ step, opt: o }); }
  };
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 10 }} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
        <Head card={card} />
        {shownSummary(card) ? <Sec title="要約"><T>{shownSummary(card)}</T></Sec> : null}
        {card.sections.filter(s => s.kind === 'caution').map((s, k) => <SectionView key={k} s={s} />)}
        {(card.inputs ?? []).map(i => (
          <Sec key={i.id} title={i.label + (i.required ? '（必須）' : '（書かなくてよい）')}>
            <TextInput value={inputs[i.id] ?? ''} onChangeText={t => setInputs(v => ({ ...v, [i.id]: t }))} multiline maxLength={i.maxLength}
              placeholder="担当への一言（キーボードのマイクで話して書ける）" placeholderTextColor={c.sub}
              style={{ minHeight: 70, borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 8, backgroundColor: c.screen, color: c.ink, fontSize: 13, textAlignVertical: 'top' }} />
          </Sec>
        ))}
        <Sec title="押すと決まります" variant="rec">
          <View style={{ gap: 8 }}>
            {missing ? <T style={{ fontSize: 12, color: c.urgent }}>上の必須の欄を書くと押せます</T> : null}
            {opts.map(o => (
              <Opt key={o.id} label={sending === o.id ? '送っています…' : (o.style === 'primary' ? '★ ' : '') + o.label}
                note={o.style === 'primary' ? ['AI の推奨', o.note].filter(Boolean).join('・') : o.note}
                selected={sending === o.id} disabled={missing || !!sending} onPress={() => press(o)} />
            ))}
          </View>
        </Sec>
        {common.length ? (
          <Sec title="選択肢のどれでもない時">
            <View style={{ gap: 8 }}>
              {common.map(a => <Btn key={a.id} label={sending === a.id ? '送っています…' : a.label} disabled={!!sending} onPress={() => press({ id: a.id, label: a.label })} />)}
            </View>
          </Sec>
        ) : null}
        <TalkButton talk={talk} />
        {card.sections.filter(s => s.kind !== 'caution').map((s, k) => <SectionView key={k} s={s} />)}
        <CardTalk talk={talk} />
      </ScrollView>
      <Sheet visible={sheet?.step === 'confirm'} onClose={() => setSheet(null)}>
        <T weight="bold" style={{ fontSize: 15 }}>{`「${sheet?.opt.label ?? ''}」で決めます`}</T>
        <T style={{ color: c.sub, fontSize: 12.5 }}>{card.risk === 'external-send' ? '外へ送られる判断です。全文を確かめてから押してください' : card.risk === 'money' ? 'お金がかかる判断です' : '取り消せない判断です'}</T>
        {err ? <T style={{ color: c.urgent, fontSize: 12.5 }}>{err}</T> : null}
        <Btn label={sending ? '送っています…' : `「${sheet?.opt.label ?? ''}」で決める`} variant="primary" disabled={!!sending} onPress={() => sheet && send(sheet.opt.id, { inputs })} />
        <Btn label="やめる" onPress={() => setSheet(null)} />
      </Sheet>
      <Sheet visible={sheet?.step === 'note'} onClose={() => setSheet(null)}>
        <T weight="bold" style={{ fontSize: 15 }}>{`「${sheet?.opt.label ?? ''}」の理由（担当に返す）`}</T>
        {err ? <T style={{ color: c.urgent, fontSize: 12.5 }}>{err}</T> : null}
        <TextInput value={why} onChangeText={setWhy} multiline placeholder="例: 今回は見送る。来月もう一度出して（キーボードのマイクで話して書ける）" placeholderTextColor={c.sub}
          style={{ minHeight: 70, maxHeight: 160, borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 8, backgroundColor: c.screen, color: c.ink, fontSize: 13, textAlignVertical: 'top' }} />
        <Btn label={sending ? '送っています…' : why.trim() ? `「${sheet?.opt.label ?? ''}」で送る` : '理由を書くと送れます'} variant="danger" disabled={!!sending || !why.trim()}
          onPress={() => sheet && send(sheet.opt.id, { note: why.trim(), inputs })} />
        <Btn label="やめる" onPress={() => setSheet(null)} />
      </Sheet>
    </View>
  );
}
