// AI オフィスのアプリ。画面は mock（受信箱・送信の承認・判断カード、秘書・担当と話す・会社・号 = docs/mocks/app-chat-mock.html）に合わせる。
// 通知 API の URL（app.json の extra）があれば本物の client、空の時だけ fake（画面の確かめ用・何も送らない）。
// 下のタブは 受信箱・秘書・号・会社（src/chat/labels.ts）。設定は右上の ⚙️ から開く。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppState, Linking, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useFonts, MPLUS1p_400Regular, MPLUS1p_700Bold, MPLUS1p_800ExtraBold } from '@expo-google-fonts/m-plus-1p';
import { DotGothic16_400Regular } from '@expo-google-fonts/dotgothic16';
import type { Card } from './src/card';
import type { AgentDirectory, DailyTimes, Me, NotifyClient, Office, Summary } from './src/notify/client';
import { createFakeClient } from './src/notify/fake';
import type { HttpClient } from './src/notify/http';
import { BUNDLE_ID, isThreadTarget, registerForPush, type PushTarget } from './src/notify/push-logic';
import { createRealClient, notifyBaseUrl, onNotificationOpen, onNotificationReceived, onPushTokenChange, pushDeps, setBadge } from './src/native';
import { badgeTotal, isStaleLoad, pickOffice, syncOffices } from './src/notify/offices';
import { parseBindLink } from './src/notify/bind-link';
import { Inbox } from './src/screens/Inbox';
import { Detail, type Talk } from './src/screens/Detail';
import { Chat, type PushSignal } from './src/screens/Chat';
import { Threads } from './src/screens/Threads';
import { Company, Dept } from './src/screens/Company';
import { Daily } from './src/screens/Daily';
import { MAIN_TABS, type MainTab } from './src/chat/labels';
import { backLabel, chatKey, chatRoute, openCardThreadStack, openThreadStack, pop, push, root, tabOf, titleOf, toCardFromChat, top, withThread, type Route, type Stack } from './src/chat/nav';
import { cardAgent, cardOfThread, editionLabel, findAgent, startCardChat } from './src/chat/logic';
import { Login } from './src/screens/Login';
import { Bind } from './src/screens/Bind';
import { Settings } from './src/screens/Settings';
import { useColors } from './src/theme';
import { AppBar, Opt, Sheet, T, Toast, Btn, TabBar, type BarAction } from './src/ui';

export default function App() {
  const [fontsLoaded] = useFonts({ MPLUS1p_400Regular, MPLUS1p_700Bold, MPLUS1p_800ExtraBold, DotGothic16_400Regular });
  const client = useMemo<NotifyClient>(() => { const u = notifyBaseUrl(); return u ? createRealClient(u) : createFakeClient(); }, []);
  if (!fontsLoaded) return null;
  return <SafeAreaProvider><Main client={client} /></SafeAreaProvider>;
}

// 一覧を読めなかった時の知らせ（前の一覧は残す。黙って捨てない）
const RELOAD_FAIL = '読み直せませんでした。受信箱を引いてもう一度';


const asHttp = (c: NotifyClient): HttpClient | null => ('registerDevice' in c ? (c as HttpClient) : null);

function Main({ client }: { client: NotifyClient }) {
  const c = useColors();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [provider, setProvider] = useState('');
  const [bindCode, setBindCode] = useState<string | null>(null); // QR で受けた、まだ送っていない code
  const [stack, setStack] = useState<Stack>(root('inbox')); // 今のタブの画面の積み重ね（一番下がタブの画面）
  const [offices, setOffices] = useState<Office[]>([]);
  const [officeId, setOfficeId] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [dir, setDir] = useState<AgentDirectory | null>(null); // 今の office の担当の一覧（秘書・判断の件の相手）
  const [dirFailed, setDirFailed] = useState(false);
  const [edition, setEdition] = useState<DailyTimes | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [officeSheet, setOfficeSheet] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tapped, setTapped] = useState<PushTarget | null>(null);
  const [pushSig, setPushSig] = useState<PushSignal>(null);
  const http = asHttp(client);
  const officeRef = useRef<string | null>(null); // 今見ている office（古い office の load の結果を捨てる）
  officeRef.current = officeId;
  // この端末で判断カードから始めた話（card に話が付くまでの間を埋める・docs/design/2026-11-22-app-card-ux.md 2.3）
  const cardThreads = useRef(new Map<string, { threadId: string; agentId: string; agentName: string }>());
  const [, setThreadsSeen] = useState(0); // 対応を足したら画面を描き直す（カードの画面の「担当と話す」が同じ話を開く）
  const stopPush = useRef<(() => void) | null>(null); // token の listener を外す（サインアウトの最初に呼ぶ）

  // 会社の一覧を読み直す。サインインの後に結びつけた時も、officeId が null か一覧に無ければ最初に見える office を選ぶ。バッジも合わせる
  const reloadOffices = useCallback(async () => {
    const r = await syncOffices(client, null);
    setOffices(r.offices); setOfficeId(cur => pickOffice(r.offices, cur)); setBadge(r.badge);
  }, [client]);
  const load = useCallback(async (id: string) => {
    const [list, sum, offs] = await Promise.all([client.listCards(id), client.summary(id), client.listOffices()]);
    if (!isStaleLoad(id, officeRef.current)) { setCards(list); setSummary(sum); } // 呼んだ時と違う office を見ていたら一覧は捨てる
    setOffices(offs); setOfficeId(cur => pickOffice(offs, cur ?? id)); setBadge(badgeTotal(offs));
  }, [client]);
  const loadDir = useCallback(async (id: string) => {
    setDirFailed(false);
    try { const d = await client.chatAgents(id); if (!isStaleLoad(id, officeRef.current)) setDir(d); }
    catch { if (!isStaleLoad(id, officeRef.current)) setDirFailed(true); }
  }, [client]);

  useEffect(() => { Promise.all([client.me(), client.authProvider()]).then(([m, p]) => { setMe(m); setProvider(p); }); }, [client]);
  useEffect(() => { if (me) reloadOffices().catch(() => setToast(RELOAD_FAIL)); else if (me === null) setBadge(0); }, [me, reloadOffices]);
  useEffect(() => { if (me && officeId) load(officeId).catch(() => setToast(RELOAD_FAIL)); }, [me, officeId, load]);
  useEffect(() => { setDir(null); if (me && officeId) loadDir(officeId); }, [me, officeId, loadDir]);
  // アプリが前面に戻った時（通知の件数・結びつけが変わっていることがある）
  useEffect(() => {
    if (!me) return;
    const s = AppState.addEventListener('change', st => {
      if (st === 'active') reloadOffices().catch(() => setToast(RELOAD_FAIL));
    });
    return () => s.remove();
  }, [me, reloadOffices]);

  // 401（token の期限切れ）はサインイン画面へ戻す
  useEffect(() => http?.onUnauthorized(() => setMe(null)), [http]);
  // 通知を押した時（閉じていた時を含む）の宛先を受ける
  useEffect(() => (http ? onNotificationOpen(setTapped) : undefined), [http]);
  // 開いている間に届いた通知: 話の返事なら、開いている話が読み直す
  useEffect(() => (http ? onNotificationReceived(t => { if (isThreadTarget(t)) setPushSig(p => ({ target: t, n: (p?.n ?? 0) + 1 })); }) : undefined), [http]);
  // サインインの後と token が変わった時に、この端末を登録する
  useEffect(() => {
    if (!http || !me) return;
    const deps = pushDeps(http);
    registerForPush(deps).catch(() => undefined);
    const off = onPushTokenChange(t => { deps.env().then(e => http.registerDevice(t, e, BUNDLE_ID)).catch(() => undefined); });
    stopPush.current = off;
    return () => { off(); stopPush.current = null; };
  }, [http, me]);
  // 押した通知の行き先を開く（その結びつけのオフィスへ切り替える）。判断の件は件を探し、話の返事はその話を開く
  useEffect(() => {
    if (!tapped || !me) return;
    const t = tapped; setTapped(null);
    if (isThreadTarget(t)) {
      setOfficeId(t.bindingId);
      // 判断カードから始めた話なら、受信箱 → カード → 話 にする（戻るとカード）。分からなければ秘書のタブの上に開く
      const open = (list: Card[]) => {
        const card = cardOfThread(list, t.threadId, cardThreads.current);
        setStack(card ? openCardThreadStack(card, t) : openThreadStack(t)); // 開くたびに別の画面（前に開いていた話の本文を残さない・その話へ送らない）
        setPushSig(p => ({ target: t, n: (p?.n ?? 0) + 1 }));
      };
      client.listCards(t.bindingId).then(open, () => open([]));
      return;
    }
    client.listCards(t.bindingId).then(list => {
      const card = list.find(x => x.id === t.cardId);
      setOfficeId(t.bindingId);
      if (card) setStack(push(root('inbox'), { name: 'card', card })); else { setStack(root('inbox')); setToast('その件はもう受信箱にありません'); }
    }).catch(() => { setStack(root('inbox')); setToast('通知の件を開けませんでした。受信箱を引いて読み直してください'); });
  }, [client, me, tapped]);

  // QR（aioffice://bind?code=…）で開かれた時: code を覚え、サインインしていれば「会社とつなぐ」を code 入りで開く。送るのは本人が「つなぐ」を押した時だけ（人から渡された QR で勝手につながない・独立レビュー PR #101 B2）
  useEffect(() => {
    const take = (u: string | null) => { const code = parseBindLink(u); if (code) setBindCode(code); };
    Linking.getInitialURL().then(take).catch(() => undefined);
    const s = Linking.addEventListener('url', e => take(e.url));
    return () => s.remove();
  }, []);
  useEffect(() => {
    if (!me || !bindCode) return;
    const code = bindCode; setBindCode(null);
    setStack(push(push(root('inbox'), { name: 'settings' }), { name: 'bind', code }));
  }, [me, bindCode]);

  if (me === undefined) return null;
  if (me === null) return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.screen }}>
      <StatusBar style="auto" />
      <Login provider={provider} onSignIn={async () => { const m = await client.signIn(); setMe(m); if (m) setStack(push(push(root('inbox'), { name: 'settings' }), { name: 'bind' })); }} />
    </SafeAreaView>
  );

  const office = offices.find(o => o.id === officeId);
  const route = top(stack);
  const tab = tabOf(stack);
  const go = (r: Route) => setStack(s => push(s, r));
  const back = () => setStack(pop);
  const refresh = async () => {
    setRefreshing(true);
    try { if (officeId) await load(officeId); else await reloadOffices(); } catch { setToast('読み直せませんでした'); } finally { setRefreshing(false); }
  };
  const openCard = route.name === 'card' ? route.card : null;
  const act = async (actionId: string, v?: { note?: string; inputs?: Record<string, string> }) => {
    // 押したのに何も出ない、を作らない: 送れない時も失敗も必ず知らせに出す
    // 失敗の文は返り値でも返す（確かめ・理由のシートは知らせの上に重なるので、シートの中に出す）
    if (!openCard) return { ok: false as const, message: 'この件はもう開いていません' };
    let r: Awaited<ReturnType<NotifyClient['act']>>;
    try { r = await client.act(openCard, actionId, v); } catch { r = { ok: false, message: '送れませんでした。もう一度押してください' }; }
    if (!r.ok) { setToast(r.message); return r; }
    setToast(actionId === 'approve' ? '承認した' : actionId === 'reject' ? '却下して理由を担当に返した'
      : actionId === 'aio:none' ? 'どれでもないと理由を担当に返した' : actionId === 'aio:resolve' ? '解決にした。担当に伝えた'
        : actionId === 'aio:refresh' ? '担当に最新にするよう頼んだ。少しすると受信箱に戻ります' : '決めた。担当に伝えた');
    setStack(s => (top(s).name === 'card' ? pop(s) : s));
    if (officeId) load(officeId).catch(() => setToast(RELOAD_FAIL));
    return { ok: true as const };
  };
  const seen = async (card: Card) => {
    if (!officeId) return;
    const r = await client.markSeen(card);
    setToast(r.ok ? `「${card.title}」を見たにした` : r.message);
    if (r.ok) setCards(cs => cs.filter(x => x.id !== card.id)); // 読み直しが失敗しても、見たにした件は一覧から外す
    await load(officeId).catch(() => setToast(r.ok ? `「${card.title}」を見たにした。${RELOAD_FAIL}` : RELOAD_FAIL));
  };
  // サインアウト: この端末への通知を止めてから token を消す
  const signOut = async () => {
    stopPush.current?.(); // 先に listener を外す。端末 token は client が持つ最後の登録を DELETE する（取り直さない）
    await client.signOut();
    setBadge(0);
  };
  // ⑤ 担当と話す: この件の話（card に付いた話・この端末で始めた話）があれば続きを開き、無ければ cardId つきで作る
  const withOffice = (card: Card) => (card.bindingId || !officeId ? card : { ...card, bindingId: officeId }); // 件は今の office のもの
  const threadOfCard = (card: Card) => {
    const local = cardThreads.current.get(card.id);
    if (card.thread?.id) return { threadId: card.thread.id, agentId: card.thread.agentId ?? local?.agentId ?? '', agentName: (card.thread.agentId && dir ? findAgent(dir, card.thread.agentId)?.name : undefined) ?? local?.agentName ?? '担当' };
    return local ?? null;
  };
  const remember = (card: Card, r: { threadId: string; agent: { id: string; name: string } }) => {
    cardThreads.current.set(card.id, { threadId: r.threadId, agentId: r.agent.id, agentName: r.agent.name });
    setThreadsSeen(n => n + 1);
  };
  const talkFor = (card: Card): Talk => {
    const known = threadOfCard(card);
    const name = known?.agentName ?? (dir ? cardAgent(card, dir).name : '担当');
    return {
      name, client, bindingId: card.bindingId || officeId || '', threadId: known?.threadId ?? null, push: pushSig, onToast: setToast,
      start: async said => {
        const r = await startCardChat(client, withOffice(card), said);
        if (!r.ok) return r;
        remember(card, r);
        return { ok: true, thread: r.thread };
      },
      onStarted: () => undefined,
      // 押した時に対応を読み直す（埋め込みの話で始めた直後でも、2 本目の話を作らない）
      openFull: async () => {
        const k = threadOfCard(card);
        if (k) { go(chatRoute(k.agentId, k.agentName, k.threadId, card.id)); return; }
        const r = await startCardChat(client, withOffice(card));
        if (!r.ok) { setToast(r.message); return; }
        remember(card, r);
        go(chatRoute(r.agent.id, r.agent.name, r.threadId, card.id));
      },
    };
  };
  // 話の画面の札を押した時: 元のカードへ（一つ前がそのカードなら戻る）
  const cardFromChat = (threadId: string | null, cardId?: string) => {
    const card = (cardId ? cards.find(x => x.id === cardId) : null) ?? cardOfThread(cards, threadId, cardThreads.current);
    if (card) setStack(s => toCardFromChat(s, card));
    else setToast('この件はもう受信箱にありません（決まったか、ほかで片付きました）');
  };
  const secretary = dir ? findAgent(dir, dir.secretaryId) : undefined;

  // 右上の小さい文字（mock: 「会社の名前 ▾　⚙️」「履歴 ›　⚙️」「11/14 号 ▾　⚙️」「履歴 ›」）
  const gear: BarAction = { label: '⚙️', onPress: () => go({ name: 'settings' }), a11y: '設定' };
  const officeAction: BarAction = { label: `${office?.name ?? ''} ▾`, onPress: () => setOfficeSheet(true), a11y: `オフィスを切り替える（今は ${office?.name ?? ''}）` };
  const actions: BarAction[] =
    route.name === 'inbox' || route.name === 'company' ? [...(office ? [officeAction] : []), gear]
    : route.name === 'secretary' ? [...(secretary ? [{ label: '履歴 ›', onPress: () => go({ name: 'history', agentId: secretary.id, agentName: secretary.name }) }] : []), gear]
    : route.name === 'daily' ? [...(edition ? [{ label: `${editionLabel(edition.edition)} ▾`, onPress: () => { if (edition.url) Linking.openURL(edition.url); }, a11y: 'Web の号を開く' }] : []), gear]
    : route.name === 'chat' && route.agentId ? [{ label: '履歴 ›', onPress: () => go({ name: 'history', agentId: route.agentId, agentName: route.agentName }) }]
    : [];

  const noOffice = <View style={{ padding: 24, gap: 10 }}><T style={{ textAlign: 'center', color: c.sub }}>つないでいる会社がありません。右上の ⚙️ の設定から会社とつなぐ</T></View>;
  const needDir = (f: (d: AgentDirectory) => ReactElement) =>
    !officeId ? noOffice
    : dir ? f(dir)
    : dirFailed ? <View style={{ padding: 24, gap: 10 }}><T style={{ textAlign: 'center', color: c.sub }}>担当の一覧を読めませんでした</T><Btn label="もう一度読む" onPress={() => loadDir(officeId)} /></View>
    : null;

  const screen = (): ReactElement | null => {
    if (route.name === 'bind') return <Bind key={route.code ?? 'bind'} initialCode={route.code} client={client} email={me.email} onDone={() => { setStack(s => pop(s)); reloadOffices().catch(() => setToast(RELOAD_FAIL)); }} onToast={setToast} />;
    if (route.name === 'settings') return <Settings client={client} me={me} onBind={() => go({ name: 'bind' })} onToast={setToast} onSignOut={async () => { await signOut(); setMe(null); setStack(root('inbox')); setToast('サインアウトした。この端末への通知を止めた'); }} />;
    if (route.name === 'card') return <Detail key={route.card.id} card={route.card} onAct={act} onBack={back} talk={talkFor(route.card)}
      onClose={async () => { await seen(route.card); setStack(s => (top(s).name === 'card' ? pop(s) : s)); }} />;
    if (route.name === 'inbox') return <Inbox cards={cards} summary={summary} refreshing={refreshing} onRefresh={refresh} onOpen={card => go({ name: 'card', card })} onSeen={seen} onToast={setToast} />;
    if (route.name === 'secretary') return needDir(d => {
      const s = findAgent(d, d.secretaryId);
      return s ? <Chat key={`${officeId}:sec`} client={client} bindingId={officeId!} agentId={s.id} agentName={s.name} secretary threadId={null} latest push={pushSig} onThread={() => undefined} onToast={setToast} />
        : <T style={{ textAlign: 'center', color: c.sub, padding: 24 }}>この会社には秘書がいません</T>;
    });
    if (route.name === 'history') return officeId ? <Threads client={client} bindingId={officeId} agentId={route.agentId} onToast={setToast}
      onOpen={id => go(chatRoute(route.agentId, route.agentName, id))} /> : noOffice;
    if (route.name === 'chat') return officeId ? <Chat key={chatKey(officeId, route)} client={client} bindingId={officeId}
      agentId={route.agentId} agentName={route.agentName} secretary={!!dir && route.agentId === dir.secretaryId} threadId={route.threadId}
      latest={!route.threadId && stack[stack.length - 2]?.name === 'dept'} push={pushSig}
      onThread={id => setStack(s => withThread(s, id))}
      onCard={route.cardId || cardOfThread(cards, route.threadId, cardThreads.current) ? () => cardFromChat(route.threadId, route.cardId) : undefined}
      onToast={setToast} /> : noOffice;
    if (route.name === 'company') return officeId ? <Company client={client} bindingId={officeId} onToast={setToast} onDept={(row, color) => go({ name: 'dept', key: row.key, title: row.name, row, color })} /> : noOffice;
    if (route.name === 'dept') return <Dept row={route.row} color={route.color} onTalk={a => go(chatRoute(a.id, a.name, null))} />;
    if (route.name === 'daily') return officeId ? <Daily client={client} bindingId={officeId} onEdition={setEdition} onToast={setToast} /> : noOffice;
    return null;
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.screen }} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style="auto" />
      <AppBar title={titleOf(route)} onBack={back} backLabel={backLabel(stack)} actions={actions} />
      <View style={{ flex: 1 }}>{screen()}</View>
      <TabBar current={tab} onPress={id => setStack(root(id as MainTab))}
        tabs={MAIN_TABS.map(t => ({ ...t, badge: t.id === 'inbox' ? summary?.pending || undefined : undefined }))} />
      <Sheet visible={officeSheet} onClose={() => setOfficeSheet(false)}>
        <T weight="bold" style={{ fontSize: 15 }}>オフィス</T>
        {offices.map(o => (
          <Opt key={o.id} label={o.name} note={o.canView ? `判断待ち ${o.pending}` : '見る権限なし'} selected={false} disabled={!o.canView}
            onPress={() => { if (!o.canView) return; setOfficeId(o.id); setStack(s => root(tabOf(s))); setOfficeSheet(false); setToast(`${o.name} のオフィスに切り替えた`); }} />
        ))}
        <Btn label="閉じる" onPress={() => setOfficeSheet(false)} />
      </Sheet>
      <Toast message={toast} onDone={() => setToast(null)} />
    </SafeAreaView>
  );
}
