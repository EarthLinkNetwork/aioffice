-- 依頼元の会社の名前（ほかの会社の見回りの回では本体が依頼元の会社を読ませないので、出す時に記録する）
ALTER TABLE plugin_relay_9b8fc185f3.requests ADD COLUMN IF NOT EXISTS origin_name text;
