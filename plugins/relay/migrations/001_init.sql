-- 回覧（office の間の質問と多段の承認）の表。設計: docs/design/2026-11-21-office-relay.md
-- schema は本体が作る plugin_relay_<sha256('aioffice.relay') の先頭 10 字>。会社をまたいで 1 つの DB で、どの書き込みもその会社の回の中で行う（2.1-5）
-- requests.state: open（回っている）・answered（答えが出た）・rejected（却下）・cancelled（取り消し）
-- steps.state: open（宛先の答えを待つ）・done（答えを採った）・invalid（宛先でない人が答えた）・closed（人の手で閉じられた）・cancelled（依頼元が閉じた）
CREATE TABLE IF NOT EXISTS plugin_relay_9b8fc185f3.requests (
  id text PRIMARY KEY,
  origin_company_id text NOT NULL,
  origin_issue_id text NOT NULL,
  origin_agent_id text,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  chain jsonb NOT NULL,
  step integer NOT NULL DEFAULT 0,
  round integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'open',
  result jsonb,
  reported_step integer NOT NULL DEFAULT 0,
  returned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS requests_origin ON plugin_relay_9b8fc185f3.requests (origin_company_id, returned);
CREATE INDEX IF NOT EXISTS requests_state ON plugin_relay_9b8fc185f3.requests (state);
-- 同じ段・同じ回の課題を 2 回作らない（見回りが重なっても、行が取れた回だけが作る・2.1-2）
CREATE TABLE IF NOT EXISTS plugin_relay_9b8fc185f3.steps (
  request_id text NOT NULL,
  step integer NOT NULL,
  round integer NOT NULL,
  company_id text NOT NULL,
  user_id text NOT NULL,
  issue_id text,
  interaction_id text,
  state text NOT NULL DEFAULT 'open',
  answer jsonb,
  notified boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, step, round)
);
CREATE INDEX IF NOT EXISTS steps_company_state ON plugin_relay_9b8fc185f3.steps (company_id, state);
