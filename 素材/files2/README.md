# 「読み人知らず」自動組版アーキテクチャ v2

> Adobe製品ゼロ・校正サイクル消滅

## アーキテクチャ図 → コード対応表

```
PHASE 1 入口の合議  → phase1-normalize/   (三者合議①: Agent1表記 + Agent2構造 + Agent3意味)
PHASE 2 意味地図生成 → phase2-semantic-map/ (全文ベクトル化・構造分析・粒度測定)
PHASE 3 ルール確定   → phase3-rule-confirm/ (CSS生成・グリッド・フォント・行送り)
PHASE 4 全ページ一括 → phase4-typeset/      (Vivliostyle VFM+CSS → PDF ★合議不要)
PHASE 5 出口の合議  → phase5-quality-check/ (三者合議②: Agent1構造 + Agent2マッピング + Agent3差分)
DATA LAYER 学習基盤 → pdca-feedback/        (BigQuery・顧客別ディレクトリ・ルールベースDB)
```

## ファイル構成

```
yomibito-v2/
├── supabase/
│   ├── migrations/
│   │   └── 001_five_phase_architecture.sql   # pgvector + 全12テーブル + RPC関数
│   └── functions/
│       ├── phase1-normalize/index.ts          # PHASE 1: 三者合議① 原稿正規化
│       ├── phase2-semantic-map/index.ts       # PHASE 2: 意味地図生成
│       ├── phase3-rule-confirm/index.ts       # PHASE 3: CSS自動生成
│       ├── phase4-typeset/index.ts            # PHASE 4: Vivliostyle一括生成
│       ├── phase5-quality-check/index.ts      # PHASE 5: 三者合議② 品質検証
│       └── pdca-feedback/index.ts             # DATA LAYER: PDCAフィードバック
└── README.md
```

## API呼び出しフロー（全自動パイプライン）

```bash
# 1. 著者A/B/C原稿をアップロード後、PHASE 1実行
POST /functions/v1/phase1-normalize
{ "project_id": "...", "client_id": "..." }
→ Agent 1(表記) + Agent 2(構造) + Agent 3(意味) が並列検証
→ critical=0 なら自動でPHASE 2へ

# 2. 意味地図生成
POST /functions/v1/phase2-semantic-map
{ "project_id": "..." }
→ 全文をコンポーネント単位に分解 + ベクトル化(pgvector)
→ 自動でPHASE 3へ

# 3. ルール確定（CSS自動生成）
POST /functions/v1/phase3-rule-confirm
{ "project_id": "...", "client_id": "..." }
→ 顧客プリセット + 意味地図 → Vivliostyle用CSS
→ 自動でPHASE 4へ

# 4. 全ページ一括生成 ★合議不要・機械的実行のみ
POST /functions/v1/phase4-typeset
{ "project_id": "..." }
→ VFM + CSS → Vivliostyle → PDF
→ 自動でPHASE 5へ

# 5. 品質検証（出口の合議）
POST /functions/v1/phase5-quality-check
{ "project_id": "...", "client_id": "...", "custom_checklist": [...] }
→ Agent 1(構造) + Agent 2(マッピング) + Agent 3(差分) が並列検証
→ 19項目チェック → PASS/FAIL
→ PASSなら印刷用PDF出力（初校→再校→…消滅）

# PDCA: ユーザー修正があった場合の学習ループ
POST /functions/v1/pdca-feedback
{ "project_id": "...", "client_id": "...", "phase": "phase1", "feedbacks": [...] }
→ 差分からルール自動生成 → pgvectorに自動INSERT
→ 運用するほど精度が上がる
```

## テーブル設計（12テーブル）

| テーブル | PHASE | 役割 |
|---|---|---|
| clients | - | 顧客マスター |
| projects | - | 案件（current_phase でフェーズ管理） |
| manuscripts | 1 | 著者原稿（Word/GDoc/Markdown） |
| normalization_log | 1 | 三者合議①の各Agent結果 |
| semantic_maps | 2 | 意味地図（構造分析・粒度メトリクス） |
| content_chunks | 2 | 分解されたチャンク（pgvector embedding付き） |
| document_globals | 3 | グローバル設定 + 生成CSS |
| components | 3 | コンポーネント定義 + 個別CSS |
| page_layouts | 3 | ページレイアウト（Grid Areas） |
| typeset_jobs | 4 | Vivliostyle実行ジョブ（VFM/CSS/PDF URI） |
| quality_reports | 5 | 品質レポート（19項目 + 3Agent結果） |
| client_rules | DL | **RAGコア: pgvectorベクトル検索** |
| client_presets | DL | 顧客別ディレクトリ（10-20パターン/顧客） |
| pdca_feedback_log | DL | PDCA証跡（過去差分から自動生成） |

## コア設計哲学

1. **PG（構造）とAI（値）の完全分離** — responseSchema + temperature:0.0
2. **三者合議パターン** — PHASE 1/5 で3つのAgentが並列実行しJSON出力
3. **19項目チェック = プロンプト変数** — グローバル/顧客個別で柔軟切替
4. **PDCAは自動ループ** — 人間の修正差分がpgvectorに自動蓄積
5. **PHASE 4は合議不要** — 機械的実行のみ（InDesignのように「重い」処理をクラウド並列で数秒に）
