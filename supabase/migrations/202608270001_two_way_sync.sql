create table public.deleted_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  record_type text not null check (record_type in ('dose', 'observation')),
  client_record_id text not null,
  deleted_at timestamptz not null,
  primary key (user_id, record_type, client_record_id)
);

alter table public.deleted_records enable row level security;
revoke all on public.deleted_records from anon;
grant select, insert, update on public.deleted_records to authenticated;

create policy "Users can read own deleted records" on public.deleted_records
for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can insert own deleted records" on public.deleted_records
for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own deleted records" on public.deleted_records
for update to authenticated using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create or replace function public.sync_deletions(records jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare affected integer := 0;
declare observation_affected integer := 0;
begin
  insert into public.deleted_records (user_id, record_type, client_record_id, deleted_at)
  select auth.uid(), x.record_type, x.client_record_id, x.deleted_at
  from jsonb_to_recordset(records) as x(record_type text, client_record_id text, deleted_at timestamptz)
  on conflict (user_id, record_type, client_record_id) do update
  set deleted_at = greatest(deleted_records.deleted_at, excluded.deleted_at);

  delete from public.dose_logs d using public.deleted_records t
  where t.user_id = auth.uid() and t.record_type = 'dose'
    and d.user_id = t.user_id and d.client_record_id = t.client_record_id;
  get diagnostics affected = row_count;

  delete from public.observations o using public.deleted_records t
  where t.user_id = auth.uid() and t.record_type = 'observation'
    and o.user_id = t.user_id and o.client_record_id = t.client_record_id;
  get diagnostics observation_affected = row_count;
  return affected + observation_affected;
end;
$$;

grant execute on function public.sync_deletions(jsonb) to authenticated;
revoke execute on function public.sync_deletions(jsonb) from public, anon;

create or replace function public.sync_dose_logs(records jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare affected integer;
begin
  insert into public.dose_logs (
    user_id, client_record_id, scheduled_at, taken_at, timezone,
    medication_name, dose, status, note, source_created_at, source_updated_at
  )
  select auth.uid(), x.client_record_id, x.scheduled_at, x.taken_at,
    coalesce(x.timezone, 'Europe/Stockholm'), x.medication_name, x.dose,
    x.status::public.dose_status, x.note, x.source_created_at, x.source_updated_at
  from jsonb_to_recordset(records) as x(
    client_record_id text, scheduled_at timestamptz, taken_at timestamptz,
    timezone text, medication_name text, dose text, status text, note text,
    source_created_at timestamptz, source_updated_at timestamptz
  )
  where not exists (
    select 1 from public.deleted_records t where t.user_id = auth.uid()
      and t.record_type = 'dose' and t.client_record_id = x.client_record_id
  )
  on conflict (user_id, client_record_id) do update set
    scheduled_at = excluded.scheduled_at, taken_at = excluded.taken_at,
    timezone = excluded.timezone, medication_name = excluded.medication_name,
    dose = excluded.dose, status = excluded.status, note = excluded.note,
    source_created_at = excluded.source_created_at, source_updated_at = excluded.source_updated_at
  where coalesce(dose_logs.source_updated_at, '-infinity') <= coalesce(excluded.source_updated_at, '-infinity');
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.sync_observations(records jsonb) returns integer
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
    category text, severity smallint, source_created_at timestamptz, source_updated_at timestamptz
  )
  where not exists (
    select 1 from public.deleted_records t where t.user_id = auth.uid()
      and t.record_type = 'observation' and t.client_record_id = x.client_record_id
  )
  on conflict (user_id, client_record_id) do update set
    observed_at = excluded.observed_at, timezone = excluded.timezone,
    text = excluded.text, category = excluded.category, severity = excluded.severity,
    source_created_at = excluded.source_created_at, source_updated_at = excluded.source_updated_at
  where coalesce(observations.source_updated_at, '-infinity') <= coalesce(excluded.source_updated_at, '-infinity');
  get diagnostics affected = row_count;
  return affected;
end;
$$;
