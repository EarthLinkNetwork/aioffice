// 画面に共通の部品（mock の .appbar・.sec・.btn・.pill・.sheet・.toast）
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { font, tone, useColors } from './theme';
import type { CardTag } from './card';

export function T({ style, children, weight = 'ui', numberOfLines, selectable }: { style?: TextStyle | TextStyle[]; children: ReactNode; weight?: keyof typeof font; numberOfLines?: number; selectable?: boolean }) {
  const c = useColors();
  return <Text selectable={selectable} numberOfLines={numberOfLines} style={[{ color: c.ink, fontFamily: font[weight], fontSize: 14, lineHeight: 21 }, style as TextStyle]}>{children}</Text>;
}

// 上の帯（mock の .bar）: 戻る・題・右の小さい文字（「履歴 ›」「会社の名前 ▾」「⚙️」など）
export type BarAction = { label: string; onPress: () => void; a11y?: string };
export function AppBar({ title, onBack, backLabel, actions = [] }: { title: string; onBack?: () => void; backLabel?: string | null; actions?: BarAction[] }) {
  const c = useColors();
  return (
    <View style={s.appbar}>
      {onBack && backLabel ? <Pressable onPress={onBack} accessibilityRole="button" hitSlop={8}><T style={{ color: c.accent, fontSize: 15 }}>{backLabel}</T></Pressable> : null}
      <T weight="heavy" style={{ fontSize: 19, flexShrink: 1 }} numberOfLines={1}>{title}</T>
      <View style={{ flex: 1 }} />
      {actions.map(a => (
        <Pressable key={a.label} onPress={a.onPress} accessibilityRole="button" accessibilityLabel={a.a11y ?? a.label} hitSlop={8}>
          <T style={{ fontSize: a.label === '⚙️' ? 17 : 12.5, color: c.sub }}>{a.label}</T>
        </Pressable>
      ))}
    </View>
  );
}

// 丸い頭文字（mock の .av）
export function Avatar({ name, color }: { name: string; color: string }) {
  const c = useColors();
  return (
    <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
      <T weight="bold" style={{ fontSize: 13, color: c.accentInk }}>{Array.from(name)[0] ?? ''}</T>
    </View>
  );
}

// 小さい札（mock の .chip）
export function Chip({ label, color }: { label: string; color?: string }) {
  const c = useColors();
  return (
    <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 9, backgroundColor: c.card, alignSelf: 'flex-start' }}>
      <T style={{ fontSize: 11, lineHeight: 18, color: color ?? c.sub }}>{label}</T>
    </View>
  );
}

export function Sec({ title, children, variant }: { title?: string; children: ReactNode; variant?: 'rec' | 'warn' }) {
  const c = useColors();
  const border = variant === 'rec' ? c.accent + '73' : variant === 'warn' ? c.sns + '80' : c.line;
  return (
    <View style={{ backgroundColor: c.card, borderWidth: 1, borderColor: border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, gap: 6 }}>
      {title ? <T weight="bold" style={{ fontSize: 11.5, letterSpacing: 0.7, color: c.sub }}>{title}</T> : null}
      {children}
    </View>
  );
}

export function Pill({ tag }: { tag: CardTag }) {
  const c = useColors(); const { fg, bg } = tone(c, tag.tone);
  // 題の文の中に並べる（mock: 札の後ろに題が続いて折り返す）
  return <View style={{ backgroundColor: bg, borderRadius: 6, paddingHorizontal: 6, marginRight: 4, transform: [{ translateY: 3 }] }}><T weight="bold" style={{ fontSize: 10.5, lineHeight: 17, color: fg }}>{tag.label}</T></View>;
}

export function Btn({ label, onPress, variant, disabled, style, small }: { label: string; onPress: () => void; variant?: 'primary' | 'danger'; disabled?: boolean; style?: ViewStyle; small?: boolean }) {
  const c = useColors();
  const primary = variant === 'primary';
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [{ borderRadius: 12, paddingVertical: small ? 4 : 11, paddingHorizontal: small ? 10 : 0, alignItems: 'center', borderWidth: 1, borderColor: primary ? c.accent : c.line, backgroundColor: primary ? c.accent : c.card, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }, style]}>
      <T weight="bold" style={{ fontSize: small ? 12 : 14, color: primary ? c.accentInk : variant === 'danger' ? c.urgent : c.ink }}>{label}</T>
    </Pressable>
  );
}

// 下のタブ（mock の .tabs）。毎日使う 4 つ（並びと名前は src/chat/labels.ts）
export function TabBar({ tabs, current, onPress }: { tabs: { id: string; icon: string; label: string; badge?: number }[]; current: string; onPress: (id: string) => void }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.card }} accessibilityRole="tablist">
      {tabs.map(t => {
        const on = t.id === current;
        return (
          <Pressable key={t.id} onPress={() => onPress(t.id)} accessibilityRole="tab" accessibilityState={{ selected: on }} style={{ flex: 1, alignItems: 'center', paddingTop: 7, paddingBottom: 2 }}>
            <T style={{ fontSize: 19, lineHeight: 22 }}>{t.icon}</T>
            <T weight={on ? 'bold' : 'ui'} style={{ fontSize: 11, color: on ? c.accent : c.sub }}>{t.label}</T>
            {t.badge ? <View style={{ position: 'absolute', top: 3, left: '50%', marginLeft: 6, backgroundColor: c.urgent, borderRadius: 999, paddingHorizontal: 5 }}><T weight="bold" style={{ fontSize: 10, lineHeight: 16, color: '#fff' }}>{t.badge}</T></View> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

// 選択肢（mock の .opt: 左寄せ・名前と小さい説明・選ぶと枠が accent）
export function Opt({ label, note, selected, onPress, disabled }: { label: string; note?: string; selected: boolean; onPress: () => void; disabled?: boolean }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled }}
      style={({ pressed }) => ({ borderWidth: selected ? 2 : 1, borderColor: selected ? c.accent : c.line, backgroundColor: c.card, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, gap: 1, opacity: disabled ? 0.45 : pressed ? 0.6 : 1 })}>
      <T>{label}</T>
      {note ? <T style={{ color: c.sub, fontSize: 11.5 }}>{note}</T> : null}
    </Pressable>
  );
}

export function Sheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  const c = useColors();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* 小窓の中の文字の欄（却下の理由など）がキーボードに隠れないよう、キーボードの分だけ小窓を押し上げる（2026-11-16 実機で理由が書けなかった） */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: '#0007', justifyContent: 'flex-end' }} onPress={onClose}>
          <Pressable onPress={() => {}} style={{ backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 14, paddingTop: 16, paddingBottom: 34, gap: 10 }}>
            {children}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  const c = useColors(); const op = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!message) return;
    op.setValue(1);
    const t = setTimeout(() => Animated.timing(op, { toValue: 0, duration: 200, useNativeDriver: true }).start(onDone), 2200);
    return () => clearTimeout(t);
  }, [message]);
  if (!message) return null;
  return (
    <Animated.View accessibilityLiveRegion="polite" style={{ position: 'absolute', left: 12, right: 12, bottom: 30, opacity: op, backgroundColor: c.ink, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 }}>
      <T style={{ color: c.screen, fontSize: 13 }}>{message}</T>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  appbar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 4, paddingBottom: 8 },
});
