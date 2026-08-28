alter table public.notification_preferences
alter column minutes_before set default 10;

update public.notification_preferences
set minutes_before = 10
where minutes_before = 5;

create or replace function public.set_notification_preferences(preferences_enabled boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  insert into public.notification_preferences (user_id, enabled, minutes_before, show_medication_details)
  values (auth.uid(), preferences_enabled, 10, false)
  on conflict (user_id) do update set
    enabled = excluded.enabled,
    minutes_before = 10;
  return preferences_enabled;
end;
$$;

revoke execute on function public.set_notification_preferences(boolean) from public, anon;
grant execute on function public.set_notification_preferences(boolean) to authenticated;
