create or replace function public.configure_medication_reminder_cron(function_url text, cron_secret text) returns bigint
language plpgsql security definer set search_path = public, vault, cron, net as $$
declare job_id bigint;
declare vault_secret_id uuid;
begin
  if function_url !~ '^https://[a-z]{20}[.]supabase[.]co/functions/v1/dispatch-medication-reminders$'
    or char_length(cron_secret) < 32 then raise exception 'invalid_cron_configuration'; end if;

  select id into vault_secret_id from vault.secrets
  where name = 'medication_reminder_cron_secret' limit 1;
  if vault_secret_id is null then
    select vault.create_secret(cron_secret, 'medication_reminder_cron_secret', 'Authenticates medication reminder cron calls')
    into vault_secret_id;
  else
    perform vault.update_secret(
      vault_secret_id,
      cron_secret,
      'medication_reminder_cron_secret',
      'Authenticates medication reminder cron calls'
    );
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'dispatch-medication-reminders';
  select cron.schedule(
    'dispatch-medication-reminders', '* * * * *',
    format($command$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'medication_reminder_cron_secret' limit 1)
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
