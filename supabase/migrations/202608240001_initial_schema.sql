create type public.dose_status as enum ('planned', 'taken', 'skipped');

create table public.dose_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_record_id text not null,
  scheduled_at timestamptz not null,
  taken_at timestamptz,
  timezone text not null default 'Europe/Stockholm',
  medication_name text not null,
  dose text not null,
  status public.dose_status not null,
  note text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_record_id),
  constraint taken_status_requires_time check (
    (status = 'taken' and taken_at is not null)
    or (status in ('planned', 'skipped') and taken_at is null)
  )
);

create table public.observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_record_id text not null,
  observed_at timestamptz not null,
  timezone text not null default 'Europe/Stockholm',
  text text not null,
  category text,
  severity smallint,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_record_id),
  constraint severity_range check (severity is null or severity between 0 and 4)
);

create index dose_logs_user_scheduled_idx on public.dose_logs (user_id, scheduled_at);
create index observations_user_observed_idx on public.observations (user_id, observed_at);

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger dose_logs_updated_at before update on public.dose_logs
for each row execute function public.set_updated_at();
create trigger observations_updated_at before update on public.observations
for each row execute function public.set_updated_at();

alter table public.dose_logs enable row level security;
alter table public.observations enable row level security;

revoke all on public.dose_logs from anon;
revoke all on public.observations from anon;
grant select, insert, update, delete on public.dose_logs to authenticated;
grant select, insert, update, delete on public.observations to authenticated;

create policy "Users can read own dose logs" on public.dose_logs
for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can insert own dose logs" on public.dose_logs
for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own dose logs" on public.dose_logs
for update to authenticated using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy "Users can delete own dose logs" on public.dose_logs
for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users can read own observations" on public.observations
for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can insert own observations" on public.observations
for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own observations" on public.observations
for update to authenticated using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy "Users can delete own observations" on public.observations
for delete to authenticated using ((select auth.uid()) = user_id);

-- The browser upserts by the stable local identifier. The timestamp predicate
-- prevents an older offline edit from overwriting a newer server version.
create function public.sync_dose_logs(records jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare affected integer;
begin
  insert into public.dose_logs (
    user_id, client_record_id, scheduled_at, taken_at, timezone,
    medication_name, dose, status, note, source_created_at, source_updated_at
  )
  select
    auth.uid(), x.client_record_id, x.scheduled_at, x.taken_at,
    coalesce(x.timezone, 'Europe/Stockholm'), x.medication_name, x.dose,
    x.status::public.dose_status, x.note, x.source_created_at, x.source_updated_at
  from jsonb_to_recordset(records) as x(
    client_record_id text, scheduled_at timestamptz, taken_at timestamptz,
    timezone text, medication_name text, dose text, status text, note text,
    source_created_at timestamptz, source_updated_at timestamptz
  )
  on conflict (user_id, client_record_id) do update set
    scheduled_at = excluded.scheduled_at,
    taken_at = excluded.taken_at,
    timezone = excluded.timezone,
    medication_name = excluded.medication_name,
    dose = excluded.dose,
    status = excluded.status,
    note = excluded.note,
    source_created_at = excluded.source_created_at,
    source_updated_at = excluded.source_updated_at
  where coalesce(dose_logs.source_updated_at, '-infinity') <= coalesce(excluded.source_updated_at, '-infinity');
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create function public.sync_observations(records jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare affected integer;
begin
  insert into public.observations (
    user_id, client_record_id, observed_at, timezone, text, category,
    severity, source_created_at, source_updated_at
  )
  select auth.uid(), x.client_record_id, x.observed_at,
    coalesce(x.timezone, 'Europe/Stockholm'), x.text, x.category, x.severity,
    x.source_created_at, x.source_updated_at
  from jsonb_to_recordset(records) as x(
    client_record_id text, observed_at timestamptz, timezone text, text text,
    category text, severity smallint, source_created_at timestamptz,
    source_updated_at timestamptz
  )
  on conflict (user_id, client_record_id) do update set
    observed_at = excluded.observed_at,
    timezone = excluded.timezone,
    text = excluded.text,
    category = excluded.category,
    severity = excluded.severity,
    source_created_at = excluded.source_created_at,
    source_updated_at = excluded.source_updated_at
  where coalesce(observations.source_updated_at, '-infinity') <= coalesce(excluded.source_updated_at, '-infinity');
  get diagnostics affected = row_count;
  return affected;
end;
$$;

grant execute on function public.sync_dose_logs(jsonb) to authenticated;
grant execute on function public.sync_observations(jsonb) to authenticated;
revoke execute on function public.sync_dose_logs(jsonb) from public, anon;
revoke execute on function public.sync_observations(jsonb) from public, anon;

create table public.api_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  route text not null,
  minute_bucket timestamptz not null,
  request_count integer not null default 1,
  primary key (user_id, route, minute_bucket)
);
alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from public, anon, authenticated;

create function public.consume_api_rate_limit(route_name text, allowed_per_minute integer default 60)
returns boolean language plpgsql security definer set search_path = public as $$
declare current_count integer;
begin
  if auth.uid() is null then return false; end if;
  insert into public.api_rate_limits (user_id, route, minute_bucket, request_count)
  values (auth.uid(), route_name, date_trunc('minute', now()), 1)
  on conflict (user_id, route, minute_bucket) do update
  set request_count = api_rate_limits.request_count + 1
  returning request_count into current_count;
  return current_count <= allowed_per_minute;
end;
$$;
revoke execute on function public.consume_api_rate_limit(text, integer) from public, anon;
grant execute on function public.consume_api_rate_limit(text, integer) to authenticated;
