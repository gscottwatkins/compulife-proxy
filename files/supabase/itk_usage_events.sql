create table if not exists public.itk_usage_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null default 'quoteit',
  agent_id text,
  agent_name text,
  contact_id text,
  client_id text,
  client_name text,
  toolkit text,
  product_category text,
  carrier_profile text,
  face_amount numeric,
  term_length integer,
  quote_requests integer not null default 1,
  quotes_returned integer not null default 0,
  excluded_count integer not null default 0,
  estimated_cost numeric(10,2) not null default 0.09,
  request_meta jsonb not null default '{}'::jsonb
);

alter table public.itk_usage_events enable row level security;

create index if not exists itk_usage_events_created_at_idx
  on public.itk_usage_events (created_at desc);

create index if not exists itk_usage_events_agent_created_idx
  on public.itk_usage_events (agent_id, created_at desc);

create index if not exists itk_usage_events_toolkit_created_idx
  on public.itk_usage_events (toolkit, created_at desc);
