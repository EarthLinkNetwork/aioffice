-- メールで届ける待ちの記録（docs/review/2026-11-19-mail-notify-scope.md の r3 の 4）。同じ知らせは 1 回だけ待つ（主キーが会社と知らせの key）。
-- 001〜005 は書き換えず、新しい file で足す（本体は流した file の hash を覚えている）
CREATE TABLE IF NOT EXISTS plugin_notify_4b4010a560.mail_sends (
  company_id text NOT NULL,
  notice_key text NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  last_code text,
  sent_at timestamptz,
  PRIMARY KEY (company_id, notice_key)
);
CREATE INDEX IF NOT EXISTS mail_sends_company_due ON plugin_notify_4b4010a560.mail_sends (company_id, status, next_at);
