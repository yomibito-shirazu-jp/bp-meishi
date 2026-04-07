# 「読み人知らず」自動組版 — RAG検証パイプライン実装

## アーキテクチャ概要

```
[Google Drive] → [GCS] → [Gemini 1.5 Pro] → [Supabase PostgreSQL + pgvector]
                                                        ↓
                                              [Edge Functions (API)]
                                                        ↓
                                              [React Dashboard (UI)]
                                                        ↓
                                              [Vivliostyle → PDF]
                                                        ↓
                                              [PDCA → RAG自動更新]
```

## コア設計哲学

> **PG（構造・事実）** と **AI（パラメータ値）** の完全分離
> - 構造はJSONスキーマでPGがガチガチに固定
> - AIは`responseSchema` + `temperature: 0.0`で値の穴埋めのみ
> - = **間違えにくい（ハルシネーション封じ込め）**

---

## ファイル構成

```
yomibito-shirazu/
├── supabase/
│   ├── migrations/
│   │   └── 001_create_rag_pipeline_tables.sql  # pgvector + 全テーブル
│   └── functions/
│       ├── layout-detect/index.ts    # モードA: 構造抽出API
│       ├── rag-validate/index.ts     # モードB: RAG検証API
│       ├── consensus-report/index.ts # 第一レポート（合議）API
│       └── pdca-feedback/index.ts    # PDCAフィードバックAPI
└── frontend/
    └── ConsensusReportDashboard.tsx  # 第一レポートUI（React）
```

---

## セットアップ手順

### 1. Supabase プロジェクト作成

```bash
supabase init
supabase link --project-ref YOUR_PROJECT_REF
```

### 2. マイグレーション実行（pgvector有効化 + テーブル作成）

```bash
supabase db push
# or
supabase migration up
```

### 3. 環境変数設定

```bash
supabase secrets set GEMINI_API_KEY=your_gemini_api_key
```

### 4. Edge Functions デプロイ

```bash
supabase functions deploy layout-detect
supabase functions deploy rag-validate
supabase functions deploy consensus-report
supabase functions deploy pdca-feedback
```

---

## APIフロー

### モードA: オンボーディング（プリセット抽出）

```
POST /functions/v1/layout-detect
{
  "project_id": "uuid",
  "gcs_uri": "gs://bucket/file.pdf",
  "mime_type": "application/pdf",
  "page_number": 1
}
→ { preset: {...}, db_status: {...} }
```

### モードB: 定期運用（RAG検証 → 第一レポート → PDCA）

**Step 1: RAG検証**
```
POST /functions/v1/rag-validate
{ "project_id": "uuid", "client_id": "uuid" }
→ { report: [...], summary: { ok: N, ng: M } }
```

**Step 2: 第一レポート生成**
```
POST /functions/v1/consensus-report
{ "project_id": "uuid" }
→ ConsensusReport JSON (→ フロントエンドに渡す)
```

**Step 3: ユーザー確認 → PDCAフィードバック**
```
POST /functions/v1/pdca-feedback
{
  "project_id": "uuid",
  "client_id": "uuid",
  "feedbacks": [
    {
      "chunk_id": "qa_box_1",
      "original": "ごはんパン麺類",
      "ai_suggestion": "ごはん、パン、麺類",
      "user_final": "ごはん・パン・麺類",
      "action_type": "MANUAL_OVERRIDE",
      "chunk_role": "qa_box"
    }
  ]
}
→ { new_rules_generated: 1, details: [...] }
```

---

## テーブル設計

| テーブル | 役割 |
|---|---|
| `clients` | 顧客マスター |
| `projects` | 案件・号数 |
| `document_globals` | グローバル設定（_app.tsx相当） |
| `components` | コンポーネント定義（QA枠、レシピ枠等） |
| `page_layouts` | ページレイアウト（Grid Areas） |
| `client_rules` | **RAGコア: pgvectorで類似度検索されるルール群** |
| `content_chunks` | 原稿チャンク（コンポーネント単位に分解済み） |
| `validation_reports` | 検証レポート（layout/rag/consensus） |
| `pdca_feedback_log` | PDCAログ（差分 → 新ルール自動生成の証跡） |

---

## 「初校＝最終稿」が成立する理由

1. **シフトレフト**: Vivliostyleに渡る前にRAG+スキーマバリデーションで100%正解データを担保
2. **冪等性**: 構造（CSS）とパラメータ（JSON値）が分離 → 値を変えても他がズレない
3. **PDCA自動ループ**: ユーザーの修正差分がpgvectorに自動蓄積 → 運用するほど精度向上
4. **エビデンス自動生成**: 19項目チェック = プロンプト変数（顧客別に柔軟切替）
