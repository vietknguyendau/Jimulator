-- JIMULATOR Golf Simulator League — core tables
-- League settings, commissioners, players, the five championship events, points tables.


create schema if not exists app_private;
revoke all on schema app_private from public;

-- ---------------------------------------------------------------------------
-- League settings (single row)
-- ---------------------------------------------------------------------------
create table public.league_settings (
  id smallint primary key default 1 check (id = 1),
  league_name text not null default 'JIMULATOR Golf Simulator League',
  season_year int not null,
  -- Commissioner-approved rule for which players count toward field size
  -- when choosing the points table: everyone who teed off, or only 9-hole finishers.
  field_size_basis text not null default 'starters' check (field_size_basis in ('starters', 'finishers')),
  time_zone text not null default 'America/Chicago' check (time_zone = 'America/Chicago'),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Commissioners: Supabase Auth users allowed to run the league
-- ---------------------------------------------------------------------------
create table public.commissioners (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_commissioner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.commissioners where user_id = auth.uid());
$$;

-- Set inside workflow functions so their writes pass the guard triggers.
create or replace function app_private.in_workflow()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('jimulator.workflow', true), '') = 'on';
$$;

-- ---------------------------------------------------------------------------
-- Players (8-player maximum)
-- ---------------------------------------------------------------------------
create table public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  ghin_number text,
  handicap_index numeric(3, 1) check (handicap_index between -10 and 54),
  handicap_source text not null default 'ghin' check (handicap_source in ('ghin', 'manual')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function app_private.players_max_eight()
returns trigger
language plpgsql
as $$
begin
  if new.active and (select count(*) from public.players where active and id <> new.id) >= 8 then
    raise exception 'The league has an 8-player maximum.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger players_max_eight
  before insert or update of active on public.players
  for each row execute function app_private.players_max_eight();

-- ---------------------------------------------------------------------------
-- Events: exactly five championship events per season
-- ---------------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  season_year int not null,
  event_number int not null check (event_number between 1 and 5),
  name text not null,
  -- Shared by both sessions: same course, tees and simulator settings.
  course_name text not null default '',
  tees text not null default '',
  par9 int check (par9 between 27 and 45),
  course_rating9 numeric(4, 1) check (course_rating9 between 25 and 50),
  slope9 int check (slope9 between 55 and 155),
  sim_settings jsonb not null default '{"green_speed":"","fairway_firmness":"","wind":"","putting":"","mulligans":""}',
  status text not null default 'draft' check (status in ('draft', 'locked', 'published')),
  locked_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (season_year, event_number)
);

-- Setup is frozen once locked; status only moves through the workflow functions.
create or replace function app_private.events_guard()
returns trigger
language plpgsql
as $$
begin
  if app_private.in_workflow() then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.locked_at is distinct from old.locked_at
     or new.published_at is distinct from old.published_at then
    raise exception 'Use Lock, Unlock or Publish to change an event''s status.';
  end if;
  if old.status <> 'draft' and (
       new.course_name is distinct from old.course_name
    or new.tees is distinct from old.tees
    or new.par9 is distinct from old.par9
    or new.course_rating9 is distinct from old.course_rating9
    or new.slope9 is distinct from old.slope9
    or new.sim_settings is distinct from old.sim_settings
    or new.season_year is distinct from old.season_year
    or new.event_number is distinct from old.event_number) then
    raise exception 'This event''s setup is locked. Unlock it before changing the course, tees or simulator settings.';
  end if;
  return new;
end;
$$;

create trigger events_guard
  before update on public.events
  for each row execute function app_private.events_guard();

-- ---------------------------------------------------------------------------
-- Points tables (official rules: 8- and 4-player fields only)
-- ---------------------------------------------------------------------------
create table public.points_tables (
  field_size int not null,
  position int not null,
  points numeric(5, 2) not null,
  primary key (field_size, position)
);

insert into public.points_tables (field_size, position, points) values
  (8, 1, 16), (8, 2, 13), (8, 3, 11), (8, 4, 9), (8, 5, 7), (8, 6, 5), (8, 7, 3), (8, 8, 1),
  (4, 1, 12), (4, 2, 9), (4, 3, 6), (4, 4, 3);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.league_settings enable row level security;
alter table public.commissioners enable row level security;
alter table public.players enable row level security;
alter table public.events enable row level security;
alter table public.points_tables enable row level security;

create policy "anyone reads settings" on public.league_settings for select using (true);
create policy "commissioner updates settings" on public.league_settings for update using (public.is_commissioner());

create policy "commissioner sees commissioners" on public.commissioners for select using (public.is_commissioner());

create policy "anyone reads players" on public.players for select using (true);
create policy "commissioner adds players" on public.players for insert with check (public.is_commissioner());
create policy "commissioner edits players" on public.players for update using (public.is_commissioner());

create policy "anyone reads events" on public.events for select using (true);
create policy "commissioner edits events" on public.events for update using (public.is_commissioner());
-- No insert/delete policies: the season always has exactly five events (created by the seed).

create policy "anyone reads points tables" on public.points_tables for select using (true);
