begin;
select plan(8);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test', '', now(), now()),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.test', '', now(), now());

insert into public.dose_logs (user_id, client_record_id, scheduled_at, taken_at, medication_name, dose, status)
values
  ('00000000-0000-0000-0000-00000000000a', 'a-dose', '2026-08-24T08:00:00+02:00', '2026-08-24T08:07:00+02:00', 'A', '1', 'taken'),
  ('00000000-0000-0000-0000-00000000000b', 'b-dose', '2026-08-24T11:00:00+02:00', null, 'B', '1', 'skipped');

insert into public.observations (user_id, client_record_id, observed_at, text)
values
  ('00000000-0000-0000-0000-00000000000a', 'a-observation', '2026-08-24T10:00:00+02:00', 'A text'),
  ('00000000-0000-0000-0000-00000000000b', 'b-observation', '2026-08-24T10:00:00+02:00', 'B text');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select is((select count(*)::integer from public.dose_logs), 1, 'A sees exactly one own dose');
select is((select count(*)::integer from public.dose_logs where client_record_id = 'b-dose'), 0, 'A cannot read B dose');
select is((select count(*)::integer from public.observations), 1, 'A sees exactly one own observation');
select is((select count(*)::integer from public.observations where client_record_id = 'b-observation'), 0, 'A cannot read B observation');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
select is((select count(*)::integer from public.dose_logs), 1, 'B sees exactly one own dose');
select is((select count(*)::integer from public.dose_logs where client_record_id = 'a-dose'), 0, 'B cannot read A dose');
select is((select count(*)::integer from public.observations), 1, 'B sees exactly one own observation');
select is((select count(*)::integer from public.observations where client_record_id = 'a-observation'), 0, 'B cannot read A observation');

select * from finish();
rollback;
