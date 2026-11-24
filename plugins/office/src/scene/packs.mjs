// キャラクターの pack（コードで描く 7 つ）。元の pack.json の色・服・高さを写した定数。
// 表示名（pack.json の name）は写さない。画面に出る文字は親の labels だけから取る。
export const PACKS = {
  'fine-human': { style: 'fine', kind: 'human', height: 1.45,
    colors: ['#3a2f36', '#5a3b2e', '#86593b', '#a5643d', '#8a7262'],
    accent: '#3f5277', accents: ['#3f5277', '#c8a27a', '#8aa58a', '#d99aa5', '#6d6f7a', '#a7835b'] },
  'fine-cat': { style: 'fine', kind: 'cat', height: 1.45, outfit: 'collar',
    colors: ['#f6b26b', '#ffffff', '#a8a8b8', '#3f3a45', '#f3dcb8', '#c9a27e', '#d9c7ea', '#b8d3e6', '#8f8478'],
    accent: '#f49ac1', accents: ['#f49ac1', '#8fd3f4', '#b4e197', '#ffd166', '#c3a6ff'] },
  'fine-bear': { style: 'fine', kind: 'bear', height: 1.45, outfit: 'apron',
    colors: ['#a8754f', '#c9925e', '#7a5238', '#e6c9a0', '#f4f1ec', '#5b4636', '#b98560'],
    accent: '#3e7d5a', accents: ['#3e7d5a', '#c0504d', '#2f5d8a', '#d99a3a', '#7b5ea7'] },
  'fine-penguin': { style: 'fine', kind: 'penguin', height: 1.45, outfit: 'scarf',
    colors: ['#2f3a4f', '#3b3f4c', '#4a5d7a', '#262a38', '#5b6b84', '#36506e'],
    accent: '#e53935', accents: ['#e53935', '#43a047', '#fbc02d', '#1e88e5', '#8e24aa', '#ff7043'] },
  'fine-rabbit': { style: 'fine', kind: 'rabbit', height: 1.45, outfit: 'bow',
    colors: ['#ffffff', '#f1dcc2', '#c8b6a6', '#ece6e0', '#a68a72', '#f8e1e8', '#8c7f78', '#e9d3b0'],
    accent: '#f48fb1', accents: ['#f48fb1', '#81c784', '#ffb74d', '#64b5f6', '#ba68c8'] },
  cat: { style: 'simple', kind: 'cat', height: 1.5,
    colors: ['#f2a65a', '#9a9a9a', '#3a3a3a', '#f5f0e6', '#c98b5b', '#7d8fa3', '#e0c08a', '#5c4b3b', '#b0b0c8'],
    accent: '#ffd166' },
  robot: { style: 'simple', kind: 'robot', height: 1.6,
    colors: ['#4fc3f7', '#81c784', '#ffb74d', '#ba68c8', '#e57373', '#4db6ac', '#9575cd', '#f06292', '#aed581'],
    accent: '#263238' },
};
export const PACK_IDS = Object.keys(PACKS);

// 文字列から決まる 32 bit の hash（FNV-1a）。id から pack・色を安定して決める
export function hashId(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s ?? '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// 担当の id から pack・色・見分けの番号を決める（同じ id はいつも同じ見た目）
export function lookOf(id) {
  const h = hashId(id), packId = PACK_IDS[h % PACK_IDS.length], pack = PACKS[packId];
  return { packId, pack, col: pack.colors[(h >>> 4) % pack.colors.length], acc: pack.accent, idx: (h >>> 9) % 997 };
}
