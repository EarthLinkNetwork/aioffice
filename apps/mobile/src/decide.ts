// 判断の件で選択肢を押した時の次の段。1 回押したら送る（2026-11-13 の決定「選択肢を押したら送る」）。
// 理由が要る操作（断るなど）は理由の欄を出し、外への送信・お金・取り消せない件は確かめの画面を挟む。
import { isCommonAction, isGuarded, type Card, type CardOption } from './card.ts';

export type ChoiceStep = 'send' | 'note' | 'confirm';

// 選択肢: 本体の選択肢（無ければ actions）。共通の操作（aio:）は混ぜない（別の並びに出す）
export const choiceOptions = (card: Card): CardOption[] =>
  card.options.length ? card.options : card.actions.filter(a => !isCommonAction(a.id)).map(a => ({ id: a.id, label: a.label }));

export function choiceStep(card: Card, optionId: string): ChoiceStep {
  if (card.actions.find(a => a.id === optionId)?.needsNote) return 'note';
  if (optionId === 'aio:refresh') return 'send'; // 頼むだけで、件は決まらない
  return isGuarded(card) ? 'confirm' : 'send';
}
