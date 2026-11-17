// ② 受信箱（mock の renderInbox）。段 1 の範囲: 件数の要約・すべて／急ぎ／返信・行・右へ送る＝見た。
// 担当の帯は段 2、「左へ送る＝あとで」は段 3（設計の段階の表で分けた）。
import { useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { isGuarded, isNotice, isUrgent, kindIcon, pillsOf, relTime, shortDate, type Card } from '../card';
import type { Summary } from '../notify/client';
import { useColors } from '../theme';
import { Pill, T } from '../ui';

type Seg = 'all' | 'urgent' | 'mail';
const SEGS: [Seg, string][] = [['all', 'すべて'], ['urgent', '急ぎ'], ['mail', '返信']];

export function Inbox({ cards, summary, refreshing, onRefresh, onOpen, onSeen, onToast }: {
  cards: Card[]; summary: Summary | null; refreshing: boolean; onRefresh: () => void;
  onOpen: (c: Card) => void; onSeen: (c: Card) => void; onToast: (m: string) => void;
}) {
  const c = useColors();
  const [seg, setSeg] = useState<Seg>('all');
  const rows = useMemo(() => cards.filter(x => seg === 'all' || (seg === 'urgent' ? isUrgent(x) : x.risk === 'external-send')), [cards, seg]);
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 10 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <View style={{ backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, gap: 2 }}>
        <T weight="heavy" style={{ fontSize: 15 }}>判断待ち {summary?.pending ?? cards.length}・急ぎ {summary?.urgent ?? cards.filter(x => isUrgent(x)).length}</T>
        {summary?.resolvedToday ? <T style={{ fontSize: 12, color: c.sub }}>今日片付いた {summary.resolvedToday.ai + summary.resolvedToday.me} 件（AI {summary.resolvedToday.ai}・自分 {summary.resolvedToday.me}）</T> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 6 }} accessibilityRole="tablist">
        {SEGS.map(([k, l]) => (
          <Pressable key={k} onPress={() => setSeg(k)} accessibilityRole="tab" accessibilityState={{ selected: seg === k }}
            style={{ borderWidth: 1, borderColor: seg === k ? c.ink : c.line, backgroundColor: c.card, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 3 }}>
            <T weight={seg === k ? 'bold' : 'ui'} style={{ fontSize: 12, color: seg === k ? c.ink : c.sub }}>{l}</T>
          </Pressable>
        ))}
      </View>
      <View style={{ gap: 8 }}>
        {rows.map(x => <Row key={x.id} card={x} onOpen={onOpen} onSeen={onSeen} onToast={onToast} />)}
        {rows.length === 0 ? <T style={{ textAlign: 'center', color: c.sub, paddingVertical: 24 }}>判断待ちはありません</T> : null}
      </View>
      <T style={{ fontSize: 11.5, color: c.sub, textAlign: 'center' }}>右へ送る＝見た。外への送信・お金の行は送れない</T>
    </ScrollView>
  );
}

function Row({ card, onOpen, onSeen, onToast }: { card: Card; onOpen: (c: Card) => void; onSeen: (c: Card) => void; onToast: (m: string) => void }) {
  const c = useColors();
  const x = useRef(new Animated.Value(0)).current;
  const guarded = isGuarded(card) || isNotice(card);
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderMove: (_, g) => x.setValue(guarded ? Math.max(-24, Math.min(24, g.dx)) : Math.max(0, g.dx)),
    onPanResponderRelease: (_, g) => {
      if (guarded && Math.abs(g.dx) > 20) onToast(isNotice(card) ? 'お知らせは承認するまで受信箱に残る' : '外への送信・お金は開いて全文を見てから決める');
      if (!guarded && g.dx > 80) {
        Animated.timing(x, { toValue: 400, duration: 150, useNativeDriver: true }).start(() => onSeen(card));
        return;
      }
      Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: true }).start(),
  }), [card, guarded]);
  const meta = [card.ref, card.summary.replace(/。$/, ''), card.recommendation ? `推奨: ${card.recommendation}` : '', card.deadline ? `締切 ${shortDate(card.deadline)}` : ''].filter(Boolean).join('・');
  return (
    <View style={{ borderRadius: 14, overflow: 'hidden' }}>
      <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: c.ok, justifyContent: 'center', paddingHorizontal: 16 }} importantForAccessibility="no-hide-descendants">
        <T weight="bold" style={{ color: '#fff', fontSize: 12.5 }}>✓ 見た</T>
      </View>
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: x }] }}>
        <Pressable onPress={() => onOpen(card)} accessibilityRole="button"
          accessibilityActions={guarded ? [] : [{ name: 'seen', label: '見たにする' }]}
          onAccessibilityAction={e => { if (e.nativeEvent.actionName === 'seen') onSeen(card); }}
          style={{ backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', gap: 10 }}>
          <T style={{ fontSize: 18, lineHeight: 22 }}>{kindIcon(card)}</T>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
              <T weight="bold" style={{ fontSize: 13.5, flex: 1 }}>
                {pillsOf(card).map(p => <Pill key={p.label} tag={p} />)}
                {card.title}
              </T>
              <T style={{ fontSize: 11, color: c.sub }}>{relTime(card.createdAt)}</T>
            </View>
            {meta ? <T style={{ fontSize: 12, color: c.sub }} numberOfLines={2}>{meta}</T> : null}
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}
