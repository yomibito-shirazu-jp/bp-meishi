-- ============================================================
-- bp-typesetting Supabase セットアップ SQL
-- 自動組版コンポーネントDB — 検出ワークフロー用
-- Project: avakiygdyafqjrhlvbjg (ap-northeast-1)
-- URL: https://avakiygdyafqjrhlvbjg.supabase.co
-- ============================================================

-- ──────────────────────────────────────────────
-- 1. detection_sessions — 検出セッション管理
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.detection_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_name     VARCHAR NOT NULL DEFAULT '',
  customer_name    VARCHAR NOT NULL DEFAULT '',
  source_type      VARCHAR NOT NULL DEFAULT 'pdf'
                   CHECK (source_type IN ('pdf', 'idml', 'scan', 'indesign')),
  source_file_path TEXT,
  detection_status VARCHAR NOT NULL DEFAULT 'pending'
                   CHECK (detection_status IN ('pending', 'analyzing', 'reviewed', 'approved', 'failed')),
  gemini_model     VARCHAR DEFAULT 'gemini-2.5-pro',
  raw_extraction   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_analysis      JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.detection_sessions IS '検出ワークフロー - セッション管理';
COMMENT ON COLUMN public.detection_sessions.raw_extraction IS 'PG構造抽出の生データ（PyMuPDF/IDMLパーサー出力）';
COMMENT ON COLUMN public.detection_sessions.ai_analysis IS 'AI（Gemini）セマンティック分析の出力';
COMMENT ON COLUMN public.detection_sessions.validation_errors IS 'Zodスキーマバリデーションのエラーログ';

CREATE INDEX idx_detection_sessions_customer ON public.detection_sessions (customer_name);
CREATE INDEX idx_detection_sessions_status ON public.detection_sessions (detection_status);
CREATE INDEX idx_detection_sessions_created ON public.detection_sessions (created_at DESC);

-- ──────────────────────────────────────────────
-- 2. document_globals — グローバル設定（_app.tsx / global.css 相当）
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.document_globals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID REFERENCES public.detection_sessions(id) ON DELETE SET NULL,
  customer_name     VARCHAR NOT NULL,
  publication_name  VARCHAR NOT NULL DEFAULT '',
  trim_size         JSONB NOT NULL DEFAULT '{"w": 210, "h": 297, "unit": "mm", "bleed": 3}'::jsonb,
  base_grid         JSONB NOT NULL DEFAULT '{"font_size": "13Q", "line_height": "21Q", "columns": 1}'::jsonb,
  base_writing_mode VARCHAR NOT NULL DEFAULT 'horizontal-tb'
                    CHECK (base_writing_mode IN ('vertical-rl', 'horizontal-tb', 'vertical-lr')),
  design_tokens     JSONB NOT NULL DEFAULT '{}'::jsonb,
  kinsoku_rules     JSONB NOT NULL DEFAULT '{}'::jsonb,
  page_margins      JSONB NOT NULL DEFAULT '{"top": 15, "bottom": 15, "inner": 20, "outer": 15}'::jsonb,
  header_footer     JSONB NOT NULL DEFAULT '{}'::jsonb,
  version           INTEGER NOT NULL DEFAULT 1,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.document_globals IS '冊子全体のグローバル設定 — Next.jsの_app.tsx / global.css相当';
COMMENT ON COLUMN public.document_globals.trim_size IS '仕上がりサイズ {"w": mm, "h": mm, "unit": "mm", "bleed": mm}';
COMMENT ON COLUMN public.document_globals.base_grid IS '基本グリッド {"font_size": "13Q", "line_height": "21Q", "columns": 3}';
COMMENT ON COLUMN public.document_globals.design_tokens IS 'カラー・フォント定義 {"colors": {...}, "fonts": {...}}';
COMMENT ON COLUMN public.document_globals.kinsoku_rules IS '禁則処理・ぶら下げ・和欧混植アキルール';

CREATE INDEX idx_document_globals_customer ON public.document_globals (customer_name);
CREATE INDEX idx_document_globals_publication ON public.document_globals (publication_name);
CREATE INDEX idx_document_globals_active ON public.document_globals (is_active) WHERE is_active = true;

-- ──────────────────────────────────────────────
-- 3. typeset_components — コンポーネント定義（QaBox.tsx 等）
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.typeset_components (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  globals_id           UUID NOT NULL REFERENCES public.document_globals(id) ON DELETE CASCADE,
  component_code       VARCHAR NOT NULL,
  component_name       VARCHAR NOT NULL DEFAULT '',
  semantic_tag         VARCHAR NOT NULL DEFAULT 'section'
                       CHECK (semantic_tag IN ('article', 'aside', 'section', 'figure', 'nav', 'header', 'footer', 'div', 'blockquote')),
  vfm_directive        VARCHAR,
  writing_mode         VARCHAR NOT NULL DEFAULT 'inherit'
                       CHECK (writing_mode IN ('inherit', 'vertical-rl', 'horizontal-tb', 'vertical-lr')),
  style_payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  grid_definition      JSONB,
  schema_props         JSONB NOT NULL DEFAULT '{}'::jsonb,
  example_content      JSONB,
  detection_confidence NUMERIC(3,2) CHECK (detection_confidence >= 0 AND detection_confidence <= 1),
  human_reviewed       BOOLEAN NOT NULL DEFAULT false,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  UNIQUE(globals_id, component_code)
);

COMMENT ON TABLE public.typeset_components IS 'レイアウトコンポーネント定義 — Next.jsのコンポーネント相当';
COMMENT ON COLUMN public.typeset_components.component_code IS 'snake_case識別子 例: qa_box, recipe_block';
COMMENT ON COLUMN public.typeset_components.style_payload IS 'CSSパラメータ群（背景色・罫線・パディング・タイポグラフィ等）';
COMMENT ON COLUMN public.typeset_components.schema_props IS 'Props定義 {"title": "string", "image": "url"}';

CREATE INDEX idx_typeset_components_globals ON public.typeset_components (globals_id);
CREATE INDEX idx_typeset_components_code ON public.typeset_components (component_code);
CREATE INDEX idx_typeset_components_active ON public.typeset_components (is_active) WHERE is_active = true;

-- ──────────────────────────────────────────────
-- 4. page_layouts — レイアウト・スロット定義（Layout.tsx 相当）
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.page_layouts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  globals_id        UUID NOT NULL REFERENCES public.document_globals(id) ON DELETE CASCADE,
  layout_code       VARCHAR NOT NULL,
  layout_name       VARCHAR NOT NULL DEFAULT '',
  page_type         VARCHAR NOT NULL DEFAULT 'single'
                    CHECK (page_type IN ('cover', 'spread', 'single', 'back_cover', 'toc', 'colophon')),
  page_geometry     JSONB NOT NULL DEFAULT '{}'::jsonb,
  grid_template     TEXT,
  grid_areas        TEXT,
  slot_definitions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(globals_id, layout_code)
);

COMMENT ON TABLE public.page_layouts IS 'ページレイアウト/スロット定義 — Next.jsのLayout.tsx相当';
COMMENT ON COLUMN public.page_layouts.grid_areas IS 'CSS grid-template-areas 例: "header header" "main sidebar"';
COMMENT ON COLUMN public.page_layouts.slot_definitions IS 'スロット制約 [{"name":"main","allowed_components":["article"]}]';

CREATE INDEX idx_page_layouts_globals ON public.page_layouts (globals_id);
CREATE INDEX idx_page_layouts_code ON public.page_layouts (layout_code);

-- ──────────────────────────────────────────────
-- 5. content_instances — 実データマッピング（流し込みテーブル）
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.content_instances (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  globals_id       UUID NOT NULL REFERENCES public.document_globals(id) ON DELETE CASCADE,
  layout_id        UUID REFERENCES public.page_layouts(id) ON DELETE SET NULL,
  component_id     UUID REFERENCES public.typeset_components(id) ON DELETE SET NULL,
  page_number      INTEGER,
  slot_name        VARCHAR,
  content_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  issue_number     VARCHAR,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.content_instances IS '実データとコンポーネント/レイアウトのマッピング — 流し込みテーブル';
COMMENT ON COLUMN public.content_instances.content_data IS 'Props実体 — Markdown AST / テキスト / 画像パス';
COMMENT ON COLUMN public.content_instances.issue_number IS '号数（定期刊行物用） 例: Vol.42';

CREATE INDEX idx_content_instances_globals ON public.content_instances (globals_id);
CREATE INDEX idx_content_instances_layout ON public.content_instances (layout_id);
CREATE INDEX idx_content_instances_component ON public.content_instances (component_id);
CREATE INDEX idx_content_instances_page ON public.content_instances (page_number);
CREATE INDEX idx_content_instances_issue ON public.content_instances (issue_number);

-- ──────────────────────────────────────────────
-- 6. updated_at 自動更新トリガー
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_detection_sessions_updated
  BEFORE UPDATE ON public.detection_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_document_globals_updated
  BEFORE UPDATE ON public.document_globals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_typeset_components_updated
  BEFORE UPDATE ON public.typeset_components
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_page_layouts_updated
  BEFORE UPDATE ON public.page_layouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_content_instances_updated
  BEFORE UPDATE ON public.content_instances
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────
-- 7. RLS ポリシー（社内ツール向け全操作許可）
-- ──────────────────────────────────────────────
ALTER TABLE public.detection_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "detection_sessions_all" ON public.detection_sessions FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.document_globals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_globals_all" ON public.document_globals FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.typeset_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY "typeset_components_all" ON public.typeset_components FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.page_layouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "page_layouts_all" ON public.page_layouts FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.content_instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "content_instances_all" ON public.content_instances FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 完了！テーブル一覧で以下5テーブルが表示されていれば成功:
--   detection_sessions / document_globals / typeset_components
--   page_layouts / content_instances
-- ============================================================
