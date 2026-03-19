-- ============================================================
-- bp-meishi Supabase セットアップ SQL
-- Supabase Dashboard → SQL Editor に貼り付けて実行
-- ============================================================

-- ──────────────────────────────────────────────
-- 1. card_projects テーブル
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.card_projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  spans           JSONB NOT NULL DEFAULT '[]'::jsonb,
  original_spans  JSONB NOT NULL DEFAULT '[]'::jsonb,
  pdf_b64         TEXT NOT NULL DEFAULT '',
  page_mm         JSONB NOT NULL DEFAULT '[91, 55]'::jsonb,   -- [width_mm, height_mm]
  original_png_b64 TEXT,
  rebuilt_pdf_b64  TEXT,
  rebuilt_png_b64  TEXT,
  raw_id_map      JSONB,                                       -- Record<string, string[]> + _meta
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- コメント
COMMENT ON TABLE  public.card_projects IS '名刺プロジェクト';
COMMENT ON COLUMN public.card_projects.spans IS '現在のSpan配列 (JSON)';
COMMENT ON COLUMN public.card_projects.original_spans IS 'OCR初期値のSpan配列 (JSON)';
COMMENT ON COLUMN public.card_projects.pdf_b64 IS '元PDFのBase64';
COMMENT ON COLUMN public.card_projects.page_mm IS 'ページサイズ [幅mm, 高さmm]';
COMMENT ON COLUMN public.card_projects.raw_id_map IS 'Span ID マッピング + _meta (page_index, clip_rect)';

-- インデックス
CREATE INDEX IF NOT EXISTS idx_card_projects_updated
  ON public.card_projects (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_card_projects_created
  ON public.card_projects (created_at DESC);

-- ──────────────────────────────────────────────
-- 2. transcribe_projects テーブル
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.transcribe_projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  source_type     TEXT NOT NULL DEFAULT 'upload',              -- 'drive' | 'upload'
  source_url      TEXT,
  text            TEXT NOT NULL DEFAULT '',
  ai_results      JSONB NOT NULL DEFAULT '[]'::jsonb,          -- AiResult[]
  consensus_text  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.transcribe_projects IS '文字起こしプロジェクト';
COMMENT ON COLUMN public.transcribe_projects.ai_results IS '各AIモデルの結果 [{model, text, confidence?}]';
COMMENT ON COLUMN public.transcribe_projects.consensus_text IS '合議結果テキスト';

CREATE INDEX IF NOT EXISTS idx_transcribe_projects_created
  ON public.transcribe_projects (created_at DESC);

-- ──────────────────────────────────────────────
-- 3. RLS (Row Level Security) ポリシー
--    anon キーで全操作を許可（社内ツール向け）
--    本番では認証ベースに変更推奨
-- ──────────────────────────────────────────────

-- card_projects
ALTER TABLE public.card_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "card_projects_select" ON public.card_projects
  FOR SELECT USING (true);

CREATE POLICY "card_projects_insert" ON public.card_projects
  FOR INSERT WITH CHECK (true);

CREATE POLICY "card_projects_update" ON public.card_projects
  FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "card_projects_delete" ON public.card_projects
  FOR DELETE USING (true);

-- transcribe_projects
ALTER TABLE public.transcribe_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "transcribe_projects_select" ON public.transcribe_projects
  FOR SELECT USING (true);

CREATE POLICY "transcribe_projects_insert" ON public.transcribe_projects
  FOR INSERT WITH CHECK (true);

CREATE POLICY "transcribe_projects_update" ON public.transcribe_projects
  FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "transcribe_projects_delete" ON public.transcribe_projects
  FOR DELETE USING (true);

-- ──────────────────────────────────────────────
-- 4. updated_at 自動更新トリガー
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- card_projects
DROP TRIGGER IF EXISTS trg_card_projects_updated ON public.card_projects;
CREATE TRIGGER trg_card_projects_updated
  BEFORE UPDATE ON public.card_projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- transcribe_projects
DROP TRIGGER IF EXISTS trg_transcribe_projects_updated ON public.transcribe_projects;
CREATE TRIGGER trg_transcribe_projects_updated
  BEFORE UPDATE ON public.transcribe_projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────
-- 5. Storage バケット（名刺画像用、任意）
-- ──────────────────────────────────────────────
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('card-assets', 'card-assets', true)
-- ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 完了！テーブル一覧で card_projects / transcribe_projects が
-- 表示されていれば成功です。
-- ============================================================
