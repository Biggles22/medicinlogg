create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  disabled_at timestamptz,
  unique (user_id, endpoint),
  constraint push_endpoint_https check (endpoint ~ '^https://'),
  constraint push_key_lengths check (
    char_length(endpoint) between 16 and 2048
    and char_length(p256dh) between 16 and 512
    and char_length(auth) between 8 and 256
  )
);

create table public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  minutes_before smallint not null default 5 check (minutes_before between 0 and 60),
  show_medication_details boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  planned_dose_id uuid not null references public.dose_logs(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  reminder_type text not null default 'planned-dose-5m' check (reminder_type = 'planned-dose-5m'),
  reminder_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 10),
  next_attempt_at timestamptz,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error_code text,
  unique (user_id, planned_dose_id, subscription_id, reminder_type)
);

create index notification_deliveries_due_idx
on public.notification_deliveries (status, next_attempt_at, reminder_at)
where status in ('pending', 'failed');

create trigger push_subscriptions_updated_at before update on public.push_subscriptions
for each row execute function public.set_updated_at();
create trigger notification_preferences_updated_at before update on public.notification_preferences
for each row execute function public.set_updated_at();

alter table public.push_subscriptions enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_deliveries enable row level security;

revoke all on public.push_subscriptions from public, anon, authenticated;
revoke all on public.notification_preferences from public, anon, authenticated;
revoke all on public.notification_deliveries from public, anon, authenticated;
grant select on public.push_subscriptions to authenticated;
grant select on public.notification_preferences to authenticated;

create policy "Users can read own push subscriptions" on public.push_subscriptions
for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can read own notification preferences" on public.notification_preferences
for select to authenticated using ((select auth.uid()) = user_id);

create function public.register_push_subscription(
  subscription_endpoint text,
  subscription_p256dh text,
  subscription_auth text,
  subscription_user_agent text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare subscription_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if subscription_endpoint !~ '^https://' or char_length(subscription_endpoint) not between 16 and 2048
    or char_length(subscription_p256dh) not between 16 and 512
    or char_length(subscription_auth) not between 8 and 256 then
    raise exception 'invalid_push_subscription';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, disabled_at)
  values (auth.uid(), subscription_endpoint, subscription_p256dh, subscription_auth, left(subscription_user_agent, 500), null)
  on conflict (user_id, endpoint) do update set
    p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, disabled_at = null
  returning id into subscription_id;
  return subscription_id;
end;
$$;

create function public.disable_push_subscription(subscription_endpoint text) returns boolean
language plpgsql security definer set search_path = public as $$
declare affected integer;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  update public.push_subscriptions set disabled_at = now()
  where user_id = auth.uid() and endpoint = subscription_endpoint and disabled_at is null;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

create function public.set_notification_preferences(preferences_enabled boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  insert into public.notification_preferences (user_id, enabled, minutes_before, show_medication_details)
  values (auth.uid(), preferences_enabled, 5, false)
  on conflict (user_id) do update set enabled = excluded.enabled;
  return preferences_enabled;
end;
$$;

revoke execute on function public.register_push_subscription(text, text, text, text) from public, anon;
revoke execute on function public.disable_push_subscription(text) from public, anon;
revoke execute on function public.set_notification_preferences(boolean) from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.disable_push_subscription(text) to authenticated;
grant execute on function public.set_notification_preferences(boolean) to authenticated;

create function public.enqueue_due_medication_reminders(reference_time timestamptz default now()) returns integer
language plpgsql security definer set search_path = public as $$
declare affected integer;
begin
  with due_slots as (
    select d.user_id, d.scheduled_at, min(d.id::text)::uuid as planned_dose_id,
      p.minutes_before
    from public.dose_logs d
    join public.notification_preferences p on p.user_id = d.user_id and p.enabled
    where d.status = 'planned'
      and d.scheduled_at - make_interval(mins => p.minutes_before) <= reference_time
      and d.scheduled_at > reference_time
    group by d.user_id, d.scheduled_at, p.minutes_before
  )
  insert into public.notification_deliveries (
    user_id, planned_dose_id, subscription_id, reminder_type, reminder_at, next_attempt_at
  )
  select s.user_id, s.planned_dose_id, ps.id, 'planned-dose-5m',
    s.scheduled_at - make_interval(mins => s.minutes_before), reference_time
  from due_slots s
  join public.push_subscriptions ps on ps.user_id = s.user_id and ps.disabled_at is null
  on conflict (user_id, planned_dose_id, subscription_id, reminder_type) do nothing;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create function public.claim_due_notification_deliveries(reference_time timestamptz default now(), batch_size integer default 100)
returns table (
  delivery_id uuid,
  subscription_id uuid,
  endpoint text,
  p256dh text,
  auth text,
  attempt_count smallint
)
language plpgsql security definer set search_path = public as $$
begin
  perform public.enqueue_due_medication_reminders(reference_time);
  update public.notification_deliveries
  set status = 'failed', locked_until = null, next_attempt_at = reference_time
  where status = 'processing' and locked_until < reference_time;

  return query
  with candidates as (
    select d.id
    from public.notification_deliveries d
    join public.push_subscriptions s on s.id = d.subscription_id and s.disabled_at is null
    where d.status in ('pending', 'failed')
      and coalesce(d.next_attempt_at, d.reminder_at) <= reference_time
      and d.reminder_at + interval '5 minutes' > reference_time
      and d.attempt_count < 5
    order by d.reminder_at, d.created_at
    for update of d skip locked
    limit greatest(1, least(batch_size, 500))
  ), claimed as (
    update public.notification_deliveries d
    set status = 'processing', attempt_count = d.attempt_count + 1,
      locked_until = reference_time + interval '2 minutes', last_error_code = null
    from candidates c where d.id = c.id
    returning d.id, d.subscription_id, d.attempt_count
  )
  select c.id, c.subscription_id, s.endpoint, s.p256dh, s.auth, c.attempt_count
  from claimed c join public.push_subscriptions s on s.id = c.subscription_id;
end;
$$;

create function public.complete_notification_delivery(
  target_delivery_id uuid,
  delivery_succeeded boolean,
  permanent_failure boolean default false,
  error_code text default null,
  reference_time timestamptz default now()
) returns boolean
language plpgsql security definer set search_path = public as $$
declare target_subscription_id uuid;
declare current_attempt smallint;
begin
  select subscription_id, attempt_count into target_subscription_id, current_attempt
  from public.notification_deliveries where id = target_delivery_id and status = 'processing' for update;
  if target_subscription_id is null then return false; end if;

  if delivery_succeeded then
    update public.notification_deliveries set status = 'sent', sent_at = reference_time,
      locked_until = null, next_attempt_at = null, last_error_code = null
    where id = target_delivery_id;
    update public.push_subscriptions set last_success_at = reference_time
    where id = target_subscription_id;
  else
    update public.notification_deliveries set status = 'failed', locked_until = null,
      next_attempt_at = case when permanent_failure then null
        else reference_time + make_interval(mins => least(15, (2 ^ greatest(current_attempt - 1, 0))::integer)) end,
      last_error_code = left(coalesce(error_code, 'push_failed'), 100)
    where id = target_delivery_id;
    if permanent_failure then
      update public.push_subscriptions set disabled_at = reference_time where id = target_subscription_id;
    end if;
  end if;
  return true;
end;
$$;

revoke execute on function public.enqueue_due_medication_reminders(timestamptz) from public, anon, authenticated;
revoke execute on function public.claim_due_notification_deliveries(timestamptz, integer) from public, anon, authenticated;
revoke execute on function public.complete_notification_delivery(uuid, boolean, boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_due_medication_reminders(timestamptz) to service_role;
grant execute on function public.claim_due_notification_deliveries(timestamptz, integer) to service_role;
grant execute on function public.complete_notification_delivery(uuid, boolean, boolean, text, timestamptz) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create function public.configure_medication_reminder_cron(function_url text, cron_secret text) returns bigint
language plpgsql security definer set search_path = public, vault, cron, net as $$
declare job_id bigint;
begin
  if function_url !~ '^https://[a-z]{20}[.]supabase[.]co/functions/v1/dispatch-medication-reminders$'
    or char_length(cron_secret) < 32 then raise exception 'invalid_cron_configuration'; end if;
  perform vault.create_secret(cron_secret, 'medication_reminder_cron_secret', 'Authenticates medication reminder cron calls');
  perform cron.unschedule(jobid) from cron.job where jobname = 'dispatch-medication-reminders';
  select cron.schedule(
    'dispatch-medication-reminders', '* * * * *',
    format($command$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'medication_reminder_cron_secret' order by created_at desc limit 1)
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 50000
      );
    $command$, function_url)
  ) into job_id;
  return job_id;
end;
$$;

revoke execute on function public.configure_medication_reminder_cron(text, text) from public, anon, authenticated;
grant execute on function public.configure_medication_reminder_cron(text, text) to service_role;
