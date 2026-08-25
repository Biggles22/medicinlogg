create table public.gpt_oauth_requests (
  id uuid primary key default gen_random_uuid(),
  authorization_id_hash text not null unique,
  client_id text not null,
  redirect_uri text not null,
  state text not null,
  scope text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint oauth_request_expiry check (expires_at > created_at)
);

create table public.gpt_oauth_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  redirect_uri text not null,
  scope text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint oauth_code_expiry check (expires_at > created_at)
);

create table public.gpt_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  access_token_hash text not null unique,
  refresh_token_hash text not null unique,
  scope text not null,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint oauth_token_expiry_order check (refresh_expires_at > access_expires_at)
);

create index gpt_oauth_codes_user_idx on public.gpt_oauth_codes (user_id, expires_at);
create index gpt_oauth_tokens_user_idx on public.gpt_oauth_tokens (user_id, revoked_at);

create trigger gpt_oauth_tokens_updated_at before update on public.gpt_oauth_tokens
for each row execute function public.set_updated_at();

alter table public.gpt_oauth_requests enable row level security;
alter table public.gpt_oauth_codes enable row level security;
alter table public.gpt_oauth_tokens enable row level security;

revoke all on public.gpt_oauth_requests from public, anon, authenticated;
revoke all on public.gpt_oauth_codes from public, anon, authenticated;
revoke all on public.gpt_oauth_tokens from public, anon, authenticated;
grant select, insert, update, delete on public.gpt_oauth_requests to service_role;
grant select, insert, update, delete on public.gpt_oauth_codes to service_role;
grant select, insert, update, delete on public.gpt_oauth_tokens to service_role;

create function public.consume_bridge_rate_limit(
  target_user_id uuid,
  route_name text,
  allowed_per_minute integer default 10
) returns boolean
language plpgsql security definer set search_path = public as $$
declare current_count integer;
begin
  insert into public.api_rate_limits (user_id, route, minute_bucket, request_count)
  values (target_user_id, route_name, date_trunc('minute', now()), 1)
  on conflict (user_id, route, minute_bucket) do update
  set request_count = api_rate_limits.request_count + 1
  returning request_count into current_count;
  return current_count <= allowed_per_minute;
end;
$$;
revoke execute on function public.consume_bridge_rate_limit(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.consume_bridge_rate_limit(uuid, text, integer) to service_role;
