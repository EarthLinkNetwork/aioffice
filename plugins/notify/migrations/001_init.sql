-- 知らせの plugin の表。schema は本体が作る plugin_notify_<sha256('aioffice.notify') の先頭 10 字>（本体は修飾の無い名前を断る）
CREATE TABLE IF NOT EXISTS plugin_notify_4b4010a560.events (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL,
  kind text NOT NULL,
  entity_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  done boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS events_company_open ON plugin_notify_4b4010a560.events (company_id, done, id);
CREATE TABLE IF NOT EXISTS plugin_notify_4b4010a560.notices (
  company_id text NOT NULL,
  key text NOT NULL,
  kind text NOT NULL,
  origin_id text NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  PRIMARY KEY (company_id, key)
);
