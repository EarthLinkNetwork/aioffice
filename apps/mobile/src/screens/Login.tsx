// ⑧ サインイン（mock の renderLogin・初めて開いた時・タブは出さない）。方法の名前はサーバーが返す。
import { useState } from 'react';
import { View } from 'react-native';
import { useColors } from '../theme';
import { Btn, T } from '../ui';

export function Login({ provider, onSignIn }: { provider: string; onSignIn: () => Promise<void> }) {
  const c = useColors();
  const [busy, setBusy] = useState(false);
  return (
    <View style={{ flex: 1, justifyContent: 'center', gap: 14, paddingHorizontal: 20 }}>
      <View style={{ width: 72, height: 72, borderRadius: 18, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' }} importantForAccessibility="no-hide-descendants">
        <T weight="dot" style={{ fontSize: 28, lineHeight: 34, color: c.accentInk }}>AI</T>
      </View>
      <T weight="heavy" style={{ fontSize: 20, textAlign: 'center' }}>AI オフィス</T>
      <T style={{ fontSize: 13, color: c.sub, textAlign: 'center' }}>AI の担当が「決めてほしい」事を、スマホで受けて決められます。</T>
      <Btn variant="primary" label={`${provider} でサインイン`} disabled={busy} onPress={async () => { setBusy(true); await onSignIn(); setBusy(false); }} />
      <T style={{ fontSize: 13, color: c.sub, textAlign: 'center' }}>アカウントが無い時は会社の管理者に頼んでください。</T>
    </View>
  );
}
