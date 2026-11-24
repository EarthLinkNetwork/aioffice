-- 秘書の気づきの plugin の表。schema は本体が作る plugin_secretary_<sha256('aioffice.secretary') の先頭 10 字>
-- 行はすべて会社の id を持ち、読む時はその会社の行だけを読む（範囲 docs/review/2026-11-21-secretary-awareness-scope.md 保証 6）
-- state: pending（まだ渡していない）・sent（見回りに渡した）・done（結果を取り込んだ）・echo（こだまで外した）・dropped（落ち）・pref（持ち主の返事。note に本文）
-- 同じ承認の作成と判断（何度でも）を別の行にするため、一意は種類と時刻まで含める（独立レビュー P2-1）
CREATE TABLE IF NOT EXISTS plugin_secretary_c2ba71d2c4.events (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL,
  kind text NOT NULL,
  event_type text NOT NULL,
  entity_id text NOT NULL,
  issue_id text NOT NULL DEFAULT '',
  run_id text NOT NULL DEFAULT '',
  actor_type text NOT NULL DEFAULT 'unknown',
  occurred_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  round_issue_id text,
  attempts integer NOT NULL DEFAULT 0,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS events_company_entity ON plugin_secretary_c2ba71d2c4.events (company_id, event_type, entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS events_company_state ON plugin_secretary_c2ba71d2c4.events (company_id, state, id);
CREATE INDEX IF NOT EXISTS events_company_round ON plugin_secretary_c2ba71d2c4.events (company_id, round_issue_id);
CREATE INDEX IF NOT EXISTS events_company_run ON plugin_secretary_c2ba71d2c4.events (company_id, run_id) WHERE run_id <> '';
