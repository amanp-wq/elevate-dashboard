-- Ops View: who is in, late, or on leave. Run once in Supabase's SQL Editor
-- on the APP project (ugghpsupgqycsnvssseo).
--
-- Access is decided here, in the database, not in the page:
--   admin  - sees and edits every team
--   lead   - sees and edits only the groups listed on their row
--   viewer - sees every team, edits nothing (for the CEO)
-- Nobody signed out (the anon key) can read or write any of these tables.

create table if not exists ops_access (
  email  text primary key,
  role   text not null check (role in ('admin','lead','viewer')),
  groups text[] not null default '{}',
  note   text
);

create table if not exists ops_daily (
  day        date not null,
  person     text not null,
  group_name text not null,
  team       text not null,
  status     text not null check (status in ('present','late')),
  arrival    text,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (day, person)
);

create table if not exists ops_leaves (
  id         uuid primary key default gen_random_uuid(),
  person     text not null,
  group_name text not null,
  team       text not null,
  from_date  date not null,
  to_date    date not null,
  kind       text not null check (kind in ('planned','unplanned')),
  reason     text,
  applied_on date,
  updated_by text,
  updated_at timestamptz not null default now(),
  check (to_date >= from_date)
);
create index if not exists ops_leaves_to_idx on ops_leaves (to_date);

-- ── who may do what ─────────────────────────────────────────────────────────
create or replace function ops_email() returns text
  language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function ops_can_see(g text) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from ops_access a where lower(a.email) = ops_email()
    and (a.role in ('admin','viewer') or (a.role = 'lead' and g = any(a.groups))))
$$;

create or replace function ops_can_edit(g text) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from ops_access a where lower(a.email) = ops_email()
    and (a.role = 'admin' or (a.role = 'lead' and g = any(a.groups))))
$$;

alter table ops_access enable row level security;
alter table ops_daily  enable row level security;
alter table ops_leaves enable row level security;

drop policy if exists ops_access_own on ops_access;
create policy ops_access_own on ops_access for select to authenticated
  using (lower(email) = ops_email());

drop policy if exists ops_daily_read   on ops_daily;
drop policy if exists ops_daily_insert on ops_daily;
drop policy if exists ops_daily_update on ops_daily;
drop policy if exists ops_daily_delete on ops_daily;
create policy ops_daily_read   on ops_daily for select to authenticated using (ops_can_see(group_name));
create policy ops_daily_insert on ops_daily for insert to authenticated with check (ops_can_edit(group_name));
create policy ops_daily_update on ops_daily for update to authenticated using (ops_can_edit(group_name)) with check (ops_can_edit(group_name));
create policy ops_daily_delete on ops_daily for delete to authenticated using (ops_can_edit(group_name));

drop policy if exists ops_leaves_read   on ops_leaves;
drop policy if exists ops_leaves_insert on ops_leaves;
drop policy if exists ops_leaves_update on ops_leaves;
drop policy if exists ops_leaves_delete on ops_leaves;
create policy ops_leaves_read   on ops_leaves for select to authenticated using (ops_can_see(group_name));
create policy ops_leaves_insert on ops_leaves for insert to authenticated with check (ops_can_edit(group_name));
create policy ops_leaves_update on ops_leaves for update to authenticated using (ops_can_edit(group_name)) with check (ops_can_edit(group_name));
create policy ops_leaves_delete on ops_leaves for delete to authenticated using (ops_can_edit(group_name));

revoke all on ops_access, ops_daily, ops_leaves from anon;
grant select on ops_access to authenticated;
grant select, insert, update, delete on ops_daily, ops_leaves to authenticated;

-- ── who has access ──────────────────────────────────────────────────────────
-- Group names are "Team " + the lead's name as it is in config.js.
insert into ops_access (email, role, groups, note) values
  ('aman.p@elevateme.pro',    'admin', '{}', 'Aman'),
  ('shani@elevateme.pro',     'admin', '{}', 'Shani'),
  ('prachit@elevateme.pro',   'admin', '{}', 'Prachit'),
  ('soham.b@elevateme.pro',   'lead',  '{"Team Soham"}',            'Sales lead'),
  ('tejasvi.p@elevateme.pro', 'lead',  '{"Team Tejasvi"}',          'Sales lead'),
  ('mamta.d@elevateme.pro',   'lead',  '{"Team Mamta Das"}',        'Sales lead'),
  ('dhanraj.s@elevateme.pro', 'lead',  '{"Team Dhanraj Solanki"}',  'BD lead'),
  ('prem.t@elevateme.pro',    'lead',  '{"Team Prem Thakar"}',      'BD lead')
on conflict (email) do update set role = excluded.role, groups = excluded.groups, note = excluded.note;

-- The CEO, view only (fill in the real address, then run just this line):
-- insert into ops_access (email, role, note) values ('ceo@example.com', 'viewer', 'CEO') on conflict (email) do nothing;
