-- 図書室の意味の近さの検索（範囲: aicompany の docs/review/2026-11-17-library-embedding-scope.md の作り方 8・9・13）
-- 本体は plugin の migration で CREATE SEQUENCE・FUNCTION・TRIGGER を通さないので、seq と世代の番号は worker が書く
-- 埋め込み。chunks の行が消えると一緒に消える。vec は Float32 の little-endian（1024 個）。読み書きは base64 の文字で行う
CREATE TABLE IF NOT EXISTS plugin_library_e54f09c41a.embeddings (
  company_id text NOT NULL,
  chunk_id text NOT NULL,
  hash text NOT NULL,
  model_digest text NOT NULL,
  vec bytea NOT NULL,
  seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, chunk_id),
  FOREIGN KEY (company_id, chunk_id) REFERENCES plugin_library_e54f09c41a.chunks (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS embeddings_company_seq ON plugin_library_e54f09c41a.embeddings (company_id, seq);
-- 埋め込めなかった行（Ollama が生きているのにその行だけが断られた時だけ数える）。hash が変われば数え直す
CREATE TABLE IF NOT EXISTS plugin_library_e54f09c41a.embed_failures (
  company_id text NOT NULL,
  chunk_id text NOT NULL,
  hash text NOT NULL,
  tries integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, chunk_id),
  FOREIGN KEY (company_id, chunk_id) REFERENCES plugin_library_e54f09c41a.chunks (company_id, id) ON DELETE CASCADE
);
-- 会社ごとの世代の番号。chunks の行を消すたびに worker が 1 つ増やし、記憶の読み直しの合図にする
CREATE TABLE IF NOT EXISTS plugin_library_e54f09c41a.generations (
  company_id text PRIMARY KEY,
  gen bigint NOT NULL DEFAULT 0
);
