// 公開する物に入れてはいけない、特定の会社の運用の語。no-company-words.test.mjs（ファイルの中身）と、
// 公開用の repo へ写す時の確かめ（commit の文）が同じ一覧を使う。語を足す時は WORD_COUNT も同じ commit で直す。
export const WORDS = Object.freeze(['Onion', 'Daily Times', 'commander', 'masawork', '上原', '中島', 'ELNA', 'GPUwerk', 'FRSHie',
  'eln.ne.jp', 'usesources', 'DGX', 'ci1', 'ELN Community', 'DialoGrid', 'promptflow',
  // 人の名前のローマ字と、古い入口の名前（漢字の名前は上にある）。これらは大文字と小文字を区別せずに照らす（ANY_CASE）
  'Uehara', 'Nakajima', 'Ikegami', 'muwork', 'aiwork', 'U067BH0Q5',
  // 開発元の非公開の repo の名前と秘密の道具の名前（2026-11-17・コードの注釈と docs/ から外した）
  'aicompany', 'dotvault']);
// 大文字と小文字を区別せずに照らす語（UEHARA・nakajima なども捕まえる。公開用への写しの commit の文の確かめも区別しない）
export const ANY_CASE = Object.freeze(new Set(['Uehara', 'Nakajima', 'Ikegami', 'muwork', 'aiwork', 'aicompany', 'dotvault']));
// 読み損ねて空の一覧で通さないための数
export const WORD_COUNT = 24;
