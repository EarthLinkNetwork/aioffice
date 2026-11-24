// 会社（office）の一覧の読み直しと、受信箱が見る office の選び方・バッジの件数（RN に依らない部分）。
import type { NotifyClient, Office } from './client.ts';

// 今の officeId が null か一覧に無い（または見る権限が無い）時は、最初の canView の office。無ければ null
export const pickOffice = (offices: Office[], cur: string | null): string | null =>
  cur && offices.some(o => o.id === cur && o.canView) ? cur : (offices.find(o => o.canView)?.id ?? null);

// ホーム画面のバッジ: 見える全 office の未読（判断待ち）の合計
export const badgeTotal = (offices: Office[]): number =>
  offices.reduce((n, o) => n + (o.canView ? Math.max(0, o.pending) : 0), 0);

// 一覧を読み直して、受信箱が見る office とバッジの件数を返す
export async function syncOffices(client: Pick<NotifyClient, 'listOffices'>, cur: string | null): Promise<{ offices: Office[]; officeId: string | null; badge: number }> {
  const offices = await client.listOffices();
  return { offices, officeId: pickOffice(offices, cur), badge: badgeTotal(offices) };
}

// 古い office の load の結果か（呼んだ時の office と今見ている office が違えば一覧は捨てる）
export const isStaleLoad = (called: string, current: string | null): boolean => called !== current;
