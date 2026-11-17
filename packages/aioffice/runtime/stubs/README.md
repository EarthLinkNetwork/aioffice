# 入れない部品の代わり（stub）

本体（Paperclip）の依存のうち、次の 2 つは「All rights reserved・各社の利用規約に従う」の独自の許諾で、公開の image に入れて配れない。
この image が使う担当は Codex（`codex_local`）だけなので、本物の代わりに、呼ばれたら「この package には入っていない」と言って止まる部品を置く。

| 部品 | 使う本体の部品 | 許諾 |
|---|---|---|
| `@cursor/sdk` | `@paperclipai/adapter-cursor-cloud`（Cursor の担当） | © Anysphere Inc. All rights reserved（Cursor の利用規約） |
| `@anthropic-ai/claude-agent-sdk` | `@agentclientprotocol/claude-agent-acp`（Claude の担当の ACP） | © Anthropic PBC. All rights reserved（Anthropic の規約） |

名前（export）は本体が import しているものだけを置く。本体の版を上げたら `test/launcher.test.mjs` の照合が足りない名前を知らせる。
