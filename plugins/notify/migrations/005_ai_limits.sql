-- AI の使用量の上限（範囲 7 の 4・7 の 5）。001〜003 は書き換えず、新しい file で足す（本体は流した file の hash を覚えている・実測 24）
-- event に上限の失敗の判定の材料を持たせる: errorCode と error の先頭 500 文字（伏せてから切った物）
ALTER TABLE plugin_notify_4b4010a560.events ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE plugin_notify_4b4010a560.events ADD COLUMN IF NOT EXISTS error_snippet text;
-- AI オフィスが止めた担当の記録（G3）。本体の pauseReason は manual になるので、区別はこの表で行う。
-- 窓の欄は window_kind（window は SQL の予約語）。issue_ids は課題の id を , でつないだ文字（本体の DB の口は配列の引数を広げるため）
CREATE TABLE IF NOT EXISTS plugin_notify_4b4010a560.limit_pauses (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL,
  agent_id text NOT NULL,
  contract text,
  window_kind text,
  reason text NOT NULL,
  until_at timestamptz,
  paused_at timestamptz NOT NULL DEFAULT now(),
  agent_paused_at timestamptz,
  resumed_at timestamptz,
  close_reason text,
  issue_ids text,
  source_run_id text,
  source_agent_id text
);
-- 開いた記録は担当ごとに 1 つ（同じ担当を二重に記録しない）
CREATE UNIQUE INDEX IF NOT EXISTS limit_pauses_open_agent ON plugin_notify_4b4010a560.limit_pauses (company_id, agent_id) WHERE resumed_at IS NULL;
CREATE INDEX IF NOT EXISTS limit_pauses_source_run ON plugin_notify_4b4010a560.limit_pauses (company_id, source_run_id);
