-- 担当の実行の event に担当の id を持たせる（同じ担当が続けて 3 回失敗したかを見るため・保証 17）。
-- 表の形は、001 を書き換えず、新しい file で足す（本体は既にある表を作り直さない・2026-11-16 実測）
ALTER TABLE plugin_notify_4b4010a560.events ADD COLUMN IF NOT EXISTS agent_id text;
