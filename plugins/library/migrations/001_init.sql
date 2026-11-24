-- 図書室の plugin の表。schema は本体が作る plugin_library_<sha256('aioffice.library') の先頭 10 字>（本体は修飾の無い名前を断る）
-- 行はすべて会社の id を持ち、読む時はその会社の行だけを読む（保証 3）。保存するのは秘密を伏せた後の文だけ（保証 4）
CREATE TABLE IF NOT EXISTS plugin_library_e54f09c41a.events (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL,
  kind text NOT NULL,
  entity_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  done boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS events_company_open ON plugin_library_e54f09c41a.events (company_id, done, id);
-- 所蔵（分けた行）。src_id は元（issue:… comment:… document:… decision:… approval:… doc:…）、issue_id は同じ課題の物をまとめる鍵
CREATE TABLE IF NOT EXISTS plugin_library_e54f09c41a.chunks (
  company_id text NOT NULL,
  id text NOT NULL,
  src_id text NOT NULL,
  issue_id text,
  kind text NOT NULL,
  title text NOT NULL,
  date text NOT NULL DEFAULT '',
  text text NOT NULL,
  hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS chunks_company_src ON plugin_library_e54f09c41a.chunks (company_id, src_id);
-- 図書室の部屋に置いた文書（伏せた後の文・名前は file の名前だけ）
CREATE TABLE IF NOT EXISTS plugin_library_e54f09c41a.documents (
  company_id text NOT NULL,
  name text NOT NULL,
  text text NOT NULL,
  size integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, name)
);
