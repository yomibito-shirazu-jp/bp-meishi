-- ==========================================================
-- 「読み人知らず」自動組版 RAG検証パイプライン
-- Migration 001: pgvector有効化 + 全テーブル作成
-- ==========================================================

-- 1. pgvector拡張を有効化
create extension if not exists vector with schema extensions;

-- 2. 顧客マスター
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  created_at timestamptz default now()
);

-- 3. プロジェクト（案件・号数）
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  name text not null,
  status text default 'draft' check (status in ('draft','detecting','validating','ready','typesetting','delivered')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 4. グローバル設定（document_globals）
create table public.document_globals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  trim_size jsonb not null default '{"w":210,"h":297,"bleed":3}',
  base_grid jsonb not null default '{"font_size":"13Q","line_height":"21Q","columns":1}',
  design_tokens jsonb not null default '{}',
  kinsoku_rules jsonb not null default '{}',
  created_at timestamptz default now()
);

-- 5. コンポーネント定義（components）
create table public.components (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  component_type text not null,
  component_name text not null,
  semantic_tag text default 'section',
  writing_mode text default 'vertical-rl' check (writing_mode in ('vertical-rl','horizontal-tb')),
  style_payload jsonb not null default '{}',
  schema_props jsonb not null default '{}',
  max_chars integer,
  created_at timestamptz default now()
);

-- 6. ページレイアウト定義（page_layouts）
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

-- 7. 顧客別ルール（RAGベクトルDB）★核心
create table public.client_rules (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  rule_text text not null,
  rule_category text not null check (rule_category in (
    'typography','notation','overflow','kinsoku','color','image','general'
  )),
  source text default 'manual',
  embedding extensions.vector(768),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ベクトル検索用インデックス（HNSW: 高速近似最近傍）
create index on public.client_rules
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- 8. 原稿チャンク（content_chunks）
create table public.content_chunks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  chunk_id text not null,
  role text not null,
  text_content text not null,
  char_count integer generated always as (char_length(text_content)) stored,
  component_id uuid references public.components(id),
  order_index integer default 0,
  created_at timestamptz default now()
);

-- 9. 検証レポート（validation_reports）
create table public.validation_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  report_type text default 'consensus' check (report_type in ('layout','rag','consensus')),
  status text not null check (status in ('READY_FOR_TYPESETTING','NEEDS_REVISION')),
  summary jsonb not null default '{}',
  component_details jsonb not null default '[]',
  created_at timestamptz default now()
);

-- 10. PDCAフィードバックログ
create table public.pdca_feedback_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  chunk_id text not null,
  original_text text not null,
  ai_suggestion text,
  user_final text not null,
  action_type text not null check (action_type in ('ACCEPTED','MANUAL_OVERRIDE','REJECTED')),
  generated_rule_text text,
  generated_rule_id uuid references public.client_rules(id),
  created_at timestamptz default now()
);

-- 11. RAGルール検索用RPC関数（コサイン類似度）
create or replace function public.match_client_rules(
  p_client_id uuid,
  p_query_embedding extensions.vector(768),
  p_match_threshold float default 0.5,
  p_match_count int default 5
)
returns table (
  id uuid,
  rule_text text,
  rule_category text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    cr.id,
    cr.rule_text,
    cr.rule_category,
    1 - (cr.embedding <=> p_query_embedding) as similarity
  from public.client_rules cr
  where cr.client_id = p_client_id
    and cr.is_active = true
    and 1 - (cr.embedding <=> p_query_embedding) > p_match_threshold
  order by cr.embedding <=> p_query_embedding
  limit p_match_count;
end;
$$;

-- 12. RLSポリシー（基本設定）
alter table public.clients enable row level security;
alter table public.projects enable row level security;
alter table public.client_rules enable row level security;
alter table public.content_chunks enable row level security;
alter table public.validation_reports enable row level security;
alter table public.pdca_feedback_log enable row level security;

-- service_role（Edge Function）からは全アクセス可
create policy "service_role_all" on public.clients for all using (true);
create policy "service_role_all" on public.projects for all using (true);
create policy "service_role_all" on public.client_rules for all using (true);
create policy "service_role_all" on public.content_chunks for all using (true);
create policy "service_role_all" on public.validation_reports for all using (true);
create policy "service_role_all" on public.pdca_feedback_log for all using (true);

comment on table public.client_rules is 'RAG用：顧客別の組版ルール・表記ガイドライン。pgvectorでベクトル検索。';
comment on table public.pdca_feedback_log is 'PDCAループ：ユーザーの修正差分を記録し、新ルール自動生成の元データとなる。';
