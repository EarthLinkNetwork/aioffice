// 色は mock（docs/mocks/mobile-app-mock.html の :root）と同じ値。明るい・暗いの両方。
import { useColorScheme } from 'react-native';

const light = {
  screen: '#f7f8fa', card: '#ffffff', ink: '#18202b', sub: '#5d6878', line: '#dde2e8',
  accent: '#2c6bed', accentInk: '#ffffff', urgent: '#d6452f', warn: '#b7791f', ok: '#2f8a57', sns: '#7a4fd0',
};
const dark: typeof light = {
  screen: '#141922', card: '#1c2330', ink: '#e8edf4', sub: '#9aa6b6', line: '#2a3342',
  accent: '#5b8ff5', accentInk: '#0b1020', urgent: '#ff6b55', warn: '#e0a64a', ok: '#4fbf80', sns: '#a985f0',
};
export type Colors = typeof light;
export const useColors = (): Colors => (useColorScheme() === 'dark' ? dark : light);

// 札の色: mock の .pill（文字は元の色・地は 15〜18% の薄さ）
export const tone = (c: Colors, t: 'urgent' | 'money' | 'sns' | 'ok') => {
  const fg = t === 'urgent' ? c.urgent : t === 'money' ? c.warn : t === 'sns' ? c.sns : c.ok;
  return { fg, bg: fg + (t === 'money' ? '2e' : '26') };
};

export const font = { ui: 'MPLUS1p_400Regular', bold: 'MPLUS1p_700Bold', heavy: 'MPLUS1p_800ExtraBold', dot: 'DotGothic16_400Regular' };
