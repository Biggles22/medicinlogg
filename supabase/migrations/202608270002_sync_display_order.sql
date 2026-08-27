alter table public.dose_logs add column display_order integer not null default 0;

create or replace function public.sync_dose_logs(records jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare affected integer;
begin
  insert into public.dose_logs (
    user_id, client_record_id, scheduled_at, taken_at, timezone,
    medication_name, dose, status, note, display_order, source_created_at, source_updated_at
  )
  select auth.uid(), x.client_record_id, x.scheduled_at, x.taken_at,
    coalesce(x.timezone, 'Europe/Stockholm'), x.medication_name, x.dose,
    x.status::public.dose_status, x.note, coalesce(x.display_order, 0),
    x.source_created_at, x.source_updated_at
  from jsonb_to_recordset(records) as x(
    client_record_id text, scheduled_at timestamptz, taken_at timestamptz,
    timezone text, medication_name text, dose text, status text, note text,
    display_order integer, source_created_at timestamptz, source_updated_at timestamptz
  )
  where not exists (
    select 1 from public.deleted_records t where t.user_id = auth.uid()
      and t.record_type = 'dose' and t.client_record_id = x.client_record_id
  )
  on conflict (user_id, client_record_id) do update set
    scheduled_at = excluded.scheduled_at, taken_at = excluded.taken_at,
    timezone = excluded.timezone, medication_name = excluded.medication_name,
    dose = excluded.dose, status = excluded.status, note = excluded.note,
    display_order = excluded.display_order, source_created_at = excluded.source_created_at,
    source_updated_at = excluded.source_updated_at
  where coalesce(dose_logs.source_updated_at, '-infinity') <= coalesce(excluded.source_updated_at, '-infinity');
  get diagnostics affected = row_count;
  return affected;
end;
$$;
