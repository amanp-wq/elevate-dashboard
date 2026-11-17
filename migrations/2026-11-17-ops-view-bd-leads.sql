-- Prem Thakar has left; Ajay Darbar now leads a BD team (Sunil). Run once in the
-- Supabase SQL Editor after 2026-11-17-ops-view.sql.
delete from ops_access where lower(email) = 'prem.t@elevateme.pro';
insert into ops_access (email, role, groups, note) values
  ('ajay@elevateme.pro', 'lead', '{"Team Ajay Darbar"}', 'BD lead')
on conflict (email) do update set role = excluded.role, groups = excluded.groups, note = excluded.note;
