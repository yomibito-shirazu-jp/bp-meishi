-- ==========================================================
-- 「読み人知らず」自動組版アーキテクチャ v2
-- 5フェーズ完全対応マイグレーション
-- ==========================================================
-- アーキテクチャ図との対応:
--   PHASE 1: 入口の合議（三者合議①）→ manuscripts, normalization_log
--   PHASE 2: 意味地図生成 → semantic_maps, content_chunks
--   PHASE 3: ルール確定 → components, page_layouts, document_globals
--   PHASE 4: 全ページ一括生成 → typeset_jobs
--   PHASE 5: 出口の合議（三者合議②）→ quality_reports
--   DATA LAYER: 学習基盤 → client_rules(pgvector), pdca_feedback_log
-- ==========================================================

-- pgvector拡張を有効化
create extension if not exists vector with schema extensions;

-- ==========================================
-- マスターデータ
-- ==========================================

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  created_at timestamptz default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  name text not null,
  current_phase text default 'phase1' check (current_phase in (
    'phase1','phase2','phase3','phase4','phase5','delivered'
  )),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ==========================================
-- PHASE 1: 入口の合議 — 原稿正規化
-- 著者A/B/C原稿 → Agent 1(表記検証) + Agent 2(構造照合) + Agent 3(意味検証)
-- ==========================================

create table public.manuscripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  author_name text not null,
  source_format text not null check (source_format in ('word','gdoc','markdown')),
  source_uri text not null,
  raw_text text,
  status text default 'pending' check (status in ('pending','normalizing','normalized','error')),
  created_at timestamptz default now()
);

-- 三者合議①の結果ログ
create table public.normalization_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  manuscript_id uuid references public.manuscripts(id) on delete cascade,
  agent_role text not null check (agent_role in ('notation','structure','semantic')),
  findings jsonb not null default '[]',
  merged_text text,
  created_at timestamptz default now()
);

-- ==========================================
-- PHASE 2: 意味地図生成（セマンティックマップ）
-- 全文ベクトル化・構造分析・粒度測定
-- ==========================================

create table public.semantic_maps (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  structure_analysis jsonb not null default '{}',
  granularity_metrics jsonb not null default '{}',
  total_chars integer default 0,
  total_sections integer default 0,
  created_at timestamptz default now()
);

-- 分解されたチャンク（ベクトル付き）
create table public.content_chunks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  semantic_map_id uuid references public.semantic_maps(id) on delete cascade,
  chunk_id text not null,
  role text not null,
  text_content text not null,
  char_count integer generated always as (char_length(text_content)) stored,
  embedding extensions.vector(768),
  order_index integer default 0,
  created_at timestamptz default now()
);

create index on public.content_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ==========================================
-- PHASE 3: ルール確定
-- CSS生成・グリッド・フォント・行送り
-- ==========================================

create table public.document_globals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade unique,
  trim_size jsonb not null default '{"w":210,"h":297,"bleed":3}',
  base_grid jsonb not null default '{}',
  design_tokens jsonb not null default '{}',
  kinsoku_rules jsonb not null default '{}',
  generated_css text,
  created_at timestamptz default now()
);

create table public.components (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  component_type text not null,
  component_name text not null,
  semantic_tag text default 'section',
  writing_mode text default 'vertical-rl',
  style_payload jsonb not null default '{}',
  max_chars integer,
  generated_css text,
  created_at timestamptz default now()
);

create table public.page_layouts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  layout_name text not null,
  page_geometry jsonb not null default '{}',
  grid_areas text,
  allowed_components text[] default '{}',
  source_file text,
  created_at timestamptz default now()
);

-- ==========================================
-- PHASE 4: 全ページ一括生成
-- Vivliostyle VFM + CSS → PDF（合議不要・機械的実行のみ）
-- ==========================================

create table public.typeset_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  status text default 'queued' check (status in ('queued','running','completed','failed')),
  vfm_content text,
  css_content text,
  output_pdf_uri text,
  pages_generated integer default 0,
  processing_time_ms integer,
  created_at timestamptz default now(),
  completed_at timestamptz
);

-- ==========================================
-- PHASE 5: 出口の合議 — 品質検証
-- Agent 1(構造検証) + Agent 2(マッピング) + Agent 3(差分検証)
-- 19項目チェック・差分検証・プリフライト
-- ==========================================

create table public.quality_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  typeset_job_id uuid references public.typeset_jobs(id),
  overall_status text not null check (overall_status in ('PASS','FAIL')),
  agent_results jsonb not null default '{}',
  checklist_19 jsonb not null default '[]',
  diff_verification jsonb not null default '{}',
  preflight_results jsonb not null default '{}',
  evidence_pdf_uri text,
  created_at timestamptz default now()
);

-- ==========================================
-- DATA LAYER — 学習基盤
-- BigQuery差分データ・ベクトル / 顧客別ディレクトリ / ルールベースDB
-- ==========================================

-- 顧客別ルール（RAG pgvector検索）
create table public.client_rules (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  rule_text text not null,
  rule_category text not null check (rule_category in (
    'notation','typography','overflow','kinsoku','color','image','structure','general'
  )),
  source text default 'manual' check (source in ('manual','pdca_auto','onboarding','import')),
  embedding extensions.vector(768),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index on public.client_rules
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- 顧客別ディレクトリ（10-20パターン/顧客）
create table public.client_presets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  preset_name text not null,
  preset_type text not null check (preset_type in ('layout','component','style','checklist')),
  preset_data jsonb not null default '{}',
  usage_count integer default 0,
  created_at timestamptz default now()
);

-- PDCAフィードバックログ（過去差分から自動生成）
create table public.pdca_feedback_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  phase text not null check (phase in ('phase1','phase5')),
  chunk_id text,
  original_text text not null,
  ai_suggestion text,
  user_final text not null,
  action_type text not null check (action_type in ('ACCEPTED','MANUAL_OVERRIDE','REJECTED')),
  generated_rule_text text,
  generated_rule_id uuid references public.client_rules(id),
  created_at timestamptz default now()
);

-- ==========================================
-- RPCファンクション
-- ==========================================

-- RAGルール検索（コサイン類似度）
create or replace function public.match_client_rules(
  p_client_id uuid,
  p_query_embedding extensions.vector(768),
  p_match_threshold float default 0.4,
  p_match_count int default 5
)
returns table (
  id uuid,
  rule_text text,
  rule_category text,
  similarity float
)
language plpgsql as $$
begin
  return query
  select cr.id, cr.rule_text, cr.rule_category,
    1 - (cr.embedding <=> p_query_embedding) as similarity
  from public.client_rules cr
  where cr.client_id = p_client_id
    and cr.is_active = true
    and 1 - (cr.embedding <=> p_query_embedding) > p_match_threshold
  order by cr.embedding <=> p_query_embedding
  limit p_match_count;
end; $$;

-- チャンク類似検索
create or replace function public.match_chunks(
  p_project_id uuid,
  p_query_embedding extensions.vector(768),
  p_match_count int default 10
)
returns table (
  id uuid,
  chunk_id text,
  role text,
  text_content text,
  similarity float
)
language plpgsql as $$
begin
  return query
  select cc.id, cc.chunk_id, cc.role, cc.text_content,
    1 - (cc.embedding <=> p_query_embedding) as similarity
  from public.content_chunks cc
  where cc.project_id = p_project_id
  order by cc.embedding <=> p_query_embedding
  limit p_match_count;
end; $$;

-- ==========================================
-- RLS（Edge Functionからservice_roleでアクセス）
-- ==========================================
do $$ 
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "service_all" on public.%I for all using (true)', t);
  end loop;
end $$;
