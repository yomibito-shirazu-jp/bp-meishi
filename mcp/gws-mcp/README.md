# Nexus Executive AI - MCP Integration Guide

このアプリケーションは、Model Context Protocol (MCP) を通じて外部ツール（Google Workspace, Slack, Notion等）と連携するように設計されています。

## 1. 事前準備 (Google Workspace MCP)

経営者秘書として機能させるために、以下のツールをインストールすることを推奨します。

1. **Google Workspace MCP Server** のインストール:
   ```bash
   npx @modelcontextprotocol/server-google-workspace
   ```
2. **認証設定**:
   Google Cloud Consoleでプロジェクトを作成し、`credentials.json`を取得して環境変数に設定してください。

## 2. アプリケーションとの接続

このフロントエンドは、Gemini API の `tools` 機能を MCP サーバーのインターフェースとして扱います。

- **Tool Call Handling**: `services/geminiService.ts` 内の `tools` 定義に、インストールしたMCPサーバーの関数定義をコピー＆ペーストしてください。
- **Execution Flow**: 
  1. 社長が「明日の予定は？」と指示。
  2. Geminiが `manage_calendar` ツールを選択。
  3. UI側の「MCP Terminal」に実行引数が表示されます。

## 4. フェーズ3: 実データ連携の有効化 (完了)

1. **Google OAuth**: ブラウザでアプリを起動し、Googleボタンをクリックしてカレンダー・Gmailへのアクセスを許可してください。
   - **独自 OAuth フロー（推奨）**: `VITE_GOOGLE_CLIENT_ID` を `.env` に設定すると、401 時に「Google ワークスペースと再連携する」で専用の OAuth フローが使われ、`refresh_token` が確実に保存されます。Supabase の Google プロバイダーで使用している Client ID と同じ値を設定してください。
2. **MCP Remote (Windsurf)**: 
   `mcp_config.json` に `nexus-remote` を追加しました。ターミナルで `mcp-remote` の認証リンクをクリックして Supabase と接続してください。
3. **環境変数**: `.env` ファイルに Vercel 同等の変数を設定済みです。

## 3. 推奨されるMCPツール
- `@modelcontextprotocol/server-google-workspace` (カレンダー、メール、ドライブ)
- `@modelcontextprotocol/server-slack` (チームへの指示出し)
- `@modelcontextprotocol/server-notion` (資料の保存・管理)
