-- 知らせに本文の欄を足す（朝夕のまとめの一覧を入れる・保証 19「件数と一覧」）。
-- 001・002 は書き換えず、新しい file で足す（本体は流した file の hash を覚えている・実測 24）
ALTER TABLE plugin_notify_4b4010a560.notices ADD COLUMN IF NOT EXISTS body text;
