-- Event formats: individual stroke play, scramble (2 or 4), alternate shot (2),
-- shamble (2 or 4), best ball (2 or 4) and match play (singles or 2 vs 2).
--
-- * 2-person formats use the season teams; 4-person formats make each session's
--   group of four a team; match play singles pairs players inside a session.
-- * Handicaps follow the World Handicap System recommended allowances. Per-hole
--   formats (best ball, shamble, match play) give strokes on the hardest holes,
--   using the stroke index the commissioner enters from the course card.
-- * Team results: each finishing team covers as many places as it has players,
--   and every teammate gets the average of those places' points.
-- * Match play: each player earns the commissioner's win / halve points.
--
-- src/lib/formats.ts implements the same rules for the app; tests check they agree.
-- This migration replaces the scramble-only tables from 20261119000005 and carries
-- their data over.

select set_config('jimulator.workflow', 'on', false);

-- ---------------------------------------------------------------------------
-- Event and league settings
-- ---------------------------------------------------------------------------
alter table public.events drop constraint if exists events_format_check;
alter table public.events add constraint events_format_check
  check (format in ('individual', 'scramble', 'alt_shot', 'shamble', 'best_ball', 'match_play'));
alter table public.events
  add column team_size smallint not null default 2 check (team_size in (2, 4)),
  add column counting_scores smallint not null default 1 check (counting_scores between 1 and 3),
  add column match_type text not null default 'singles' check (match_type in ('singles', 'fourball')),
  add column hole_si smallint[] check (hole_si is null or (array_length(hole_si, 1) = 9 and 1 <= all (hole_si) and 18 >= all (hole_si)));

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
    or new.format is distinct from old.format
    or new.team_size is distinct from old.team_size
    or new.counting_scores is distinct from old.counting_scores
    or new.match_type is distinct from old.match_type
    or new.hole_si is distinct from old.hole_si
    or new.season_year is distinct from old.season_year
    or new.event_number is distinct from old.event_number) then
    raise exception 'This event''s setup is locked. Unlock it before changing the format, course, tees or simulator settings.';
  end if;
  return new;
end;
$$;

alter table public.league_settings
  add column match_win_points numeric(5, 2) check (match_win_points >= 0),
  add column match_halve_points numeric(5, 2) check (match_halve_points >= 0);

alter table public.session_assignments add column match_slot smallint check (match_slot in (1, 2));

-- ---------------------------------------------------------------------------
-- Entries: the competitors in a team or match event, created at lock
-- ---------------------------------------------------------------------------
create table public.event_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  session_id uuid not null references public.event_sessions (id) on delete cascade,
  team_id uuid references public.teams (id) on delete cascade,
  match_slot smallint,
  strokes int,
  confirmed_at timestamptz not null default now()
);
create index event_entries_event_idx on public.event_entries (event_id);

create table public.entry_members (
  entry_id uuid not null references public.event_entries (id) on delete cascade,
  player_id uuid not null references public.players (id),
  course_handicap numeric(8, 4) not null,
  playing_handicap int,
  primary key (entry_id, player_id)
);

-- One card per team for scramble and alternate shot; private until published.
create table public.entry_round_scores (
  entry_id uuid primary key references public.event_entries (id) on delete cascade,
  hole_scores smallint[] not null default array[null,null,null,null,null,null,null,null,null]::smallint[],
  status text not null default 'pending' check (status in ('pending', 'completed', 'dnf', 'dna')),
  updated_at timestamptz not null default now(),
  constraint nine_holes check (array_length(hole_scores, 1) = 9),
  constraint sane_hole_scores check (1 <= all (hole_scores) and 20 >= all (hole_scores))
);

create or replace function app_private.entries_guard()
returns trigger
language plpgsql
as $$
begin
  if not app_private.in_workflow() then
    raise exception 'Teams and matches are set up when the event is locked.';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger event_entries_guard before insert or update or delete on public.event_entries
  for each row execute function app_private.entries_guard();
create trigger entry_members_guard before insert or update or delete on public.entry_members
  for each row execute function app_private.entries_guard();

create or replace function app_private.entry_round_scores_guard()
returns trigger
language plpgsql
as $$
declare
  ev public.events;
  sess public.event_sessions;
  holes int;
begin
  select e.* into ev from public.events e join public.event_entries x on x.event_id = e.id where x.id = new.entry_id;
  select s.* into sess from public.event_sessions s join public.event_entries x on x.session_id = s.id where x.id = new.entry_id;
  if not app_private.in_workflow() then
    if ev.status = 'draft' then
      raise exception 'Lock the event and confirm handicaps before entering scores.';
    end if;
    if ev.status = 'published' then
      raise exception 'Results are published. Unpublish the event to correct a score.';
    end if;
    if sess.status = 'resolved' then
      raise exception 'Day % is marked complete. Reopen it to change a score.', sess.session_number;
    end if;
  end if;
  select count(*) into holes from unnest(new.hole_scores) h where h is not null;
  if new.status = 'completed' and holes <> 9 then
    raise exception 'A team must finish all 9 holes to be marked completed.';
  end if;
  if new.status = 'dna' and holes > 0 then
    raise exception 'A team that did not attend can''t have hole scores.';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger entry_round_scores_guard before insert or update on public.entry_round_scores
  for each row execute function app_private.entry_round_scores_guard();

alter table public.event_results
  add column entry_id uuid references public.event_entries (id) on delete set null,
  add column detail text;

-- Carry over scramble data from the scramble-only tables.
create temp table _carry on commit drop as
  select gen_random_uuid() as id, et.* from public.event_teams et;
insert into public.event_entries (id, event_id, session_id, team_id, strokes, confirmed_at)
  select id, event_id, session_id, team_id, strokes, confirmed_at from _carry;
insert into public.entry_members (entry_id, player_id, course_handicap)
  select id, player_a, ch_a from _carry union all select id, player_b, ch_b from _carry;
insert into public.entry_round_scores (entry_id, hole_scores, status, updated_at)
  select c.id, r.hole_scores, r.status, r.updated_at
  from _carry c join public.team_round_scores r on r.event_id = c.event_id and r.team_id = c.team_id;
update public.event_results r set entry_id = c.id from _carry c where c.event_id = r.event_id and c.team_id = r.team_id;
update public.events set team_size = 2 where format = 'scramble';

drop table public.team_round_scores;
drop table public.event_teams;
drop function if exists app_private.team_round_scores_guard();
drop function if exists app_private.event_teams_guard();
drop function if exists public.scramble_strokes(numeric, numeric);

-- ---------------------------------------------------------------------------
-- Handicap helpers
-- ---------------------------------------------------------------------------
create or replace function app_private.round_half_up(x numeric)
returns int language sql immutable as $$
  select floor(round(x, 6) + 0.5)::int;
$$;

-- Strokes a player with `ph` strokes over 9 holes gets on the hole ranked `r` (1 = hardest).
create or replace function public.hole_strokes(ph int, r int)
returns int language sql immutable as $$
  select case
    when ph >= 0 then ph / 9 + case when r <= ph % 9 then 1 else 0 end
    else -((-ph) / 9 + case when r > 9 - ((-ph) % 9) then 1 else 0 end)
  end;
$$;

-- Rank (1 = hardest) of hole `h` among the 9 by the course card's stroke index; ties go to the earlier hole.
create or replace function app_private.si_rank(si smallint[], h int)
returns int language sql immutable as $$
  select 1 + count(*)::int from generate_series(1, 9) j
  where coalesce(si[j], 99) < coalesce(si[h], 99) or (coalesce(si[j], 99) = coalesce(si[h], 99) and j < h);
$$;

create or replace function app_private.entry_size(ev public.events)
returns int language sql immutable as $$
  select case
    when ev.format = 'individual' then 1
    when ev.format = 'alt_shot' then 2
    when ev.format = 'match_play' then case when ev.match_type = 'fourball' then 2 else 1 end
    else ev.team_size
  end;
$$;

-- Team-card formats: % of each course handicap, lowest first.
create or replace function app_private.team_card_strokes(ev public.events, chs numeric[])
returns int language sql immutable as $$
  with pct as (
    select case
      when ev.format = 'alt_shot' then array[0.5, 0.5]
      when ev.team_size = 4 then array[0.25, 0.20, 0.15, 0.10]
      else array[0.35, 0.15]
    end::numeric[] as p
  )
  select app_private.round_half_up(sum(c.ch * pct.p[c.rn]))
  from (select ch, row_number() over (order by ch) as rn from unnest(chs) as ch) c, pct;
$$;

-- Per-hole formats: allowance applied before strokes are spread over the holes.
create or replace function app_private.per_hole_allowance(ev public.events)
returns numeric language sql immutable as $$
  select case
    when ev.format = 'match_play' then case when ev.match_type = 'fourball' then 0.9 else 1.0 end
    when ev.team_size = 4 then case when ev.counting_scores >= 3 then 1.0 when ev.counting_scores = 2 then 0.85 else 0.75 end
    else case when ev.counting_scores >= 2 then 1.0 else 0.85 end
  end;
$$;

create or replace function app_private.entry_label(p_entry uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(trim(t.name), '') from public.event_entries e join public.teams t on t.id = e.team_id where e.id = p_entry),
    (select case when count(*) = 1 then min(p.name) end
       from public.entry_members m join public.players p on p.id = m.player_id where m.entry_id = p_entry),
    (select 'Day ' || s.session_number || ' team' from public.event_entries e join public.event_sessions s on s.id = e.session_id where e.id = p_entry)
  );
$$;

-- ---------------------------------------------------------------------------
-- Lock: validate groups for the format, confirm handicaps, create entries
-- ---------------------------------------------------------------------------
create or replace function app_private.lock_event_core(p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ev public.events;
  n_sessions int;
  total int;
  day1 int;
  day2 int;
  sz int;
  missing text;
  team_card boolean;
  per_hole boolean;
  max_k int;
begin
  perform set_config('jimulator.workflow', 'on', true);
  select * into ev from public.events where id = p_event for update;
  if not found then raise exception 'Event not found.'; end if;
  if ev.status <> 'draft' then raise exception 'This event is already locked.'; end if;
  if trim(ev.course_name) = '' or trim(ev.tees) = '' then
    raise exception 'Choose the simulator course and tees before locking.';
  end if;
  if ev.par9 is null or ev.course_rating9 is null or ev.slope9 is null then
    raise exception 'Enter the 9-hole par, course rating and slope before locking.';
  end if;

  select count(*) into n_sessions from public.event_sessions where event_id = p_event;
  select count(*) into total from public.session_assignments where event_id = p_event;
  select count(*) into day1 from public.session_assignments a join public.event_sessions s on s.id = a.session_id
    where a.event_id = p_event and s.session_number = 1;
  day2 := total - day1;

  if n_sessions = 0 then raise exception 'Schedule Day 1 before locking.'; end if;
  if total = 0 then raise exception 'Assign players before locking.'; end if;
  if total <= 4 and n_sessions = 2 then
    raise exception 'With % players, everyone plays together in one session. Move everyone to Day 1 and remove Day 2.', total;
  end if;
  if total > 4 and (n_sessions < 2 or day1 = 0 or day2 = 0) then
    raise exception '% players need two sessions with players in each.', total;
  end if;
  if total = 8 and (day1 <> 4 or day2 <> 4) then
    raise exception 'An eight-player event plays four on Day 1 and four on Day 2.';
  end if;

  select string_agg(p.name, ', ') into missing
  from public.session_assignments a join public.players p on p.id = a.player_id
  where a.event_id = p_event and p.handicap_index is null;
  if missing is not null then
    raise exception 'Missing handicap index: %.', missing;
  end if;

  sz := app_private.entry_size(ev);
  team_card := ev.format in ('scramble', 'alt_shot');
  per_hole := ev.format in ('shamble', 'best_ball', 'match_play');

  if per_hole and (ev.hole_si is null or exists (select 1 from unnest(ev.hole_si) v where v is null)
                   or (select count(distinct v) from unnest(ev.hole_si) v) <> 9) then
    raise exception 'Enter a different stroke index (handicap hole) for each of the 9 holes from the course card.';
  end if;
  max_k := case when sz = 4 then 3 else 2 end;
  if ev.format in ('shamble', 'best_ball') and ev.counting_scores > max_k then
    raise exception 'Pick how many scores count on each hole (1–%).', max_k;
  end if;

  if sz = 2 then
    select string_agg(p.name, ', ') into missing
    from public.session_assignments a join public.players p on p.id = a.player_id
    where a.event_id = p_event and not exists (
      select 1 from public.teams t where t.season_year = ev.season_year and a.player_id in (t.player_a, t.player_b));
    if missing is not null then
      raise exception 'Not on a 2-person team: %. Add them to a team first.', missing;
    end if;
    select string_agg(t.name, ', ') into missing
    from public.teams t
    join public.session_assignments a1 on a1.event_id = p_event and a1.player_id in (t.player_a, t.player_b)
    where t.season_year = ev.season_year and not exists (
      select 1 from public.session_assignments a2
      where a2.event_id = p_event and a2.session_id = a1.session_id
        and a2.player_id = case when a1.player_id = t.player_a then t.player_b else t.player_a end);
    if missing is not null then
      raise exception 'Both teammates must be assigned to the same day: %.', missing;
    end if;
  end if;
  if sz = 4 or (ev.format = 'match_play' and sz = 2) then
    select string_agg('Day ' || s.session_number, ', ') into missing
    from public.event_sessions s
    where s.event_id = p_event
      and (select count(*) from public.session_assignments a where a.session_id = s.id) not in (0, 4);
    if missing is not null then
      raise exception '% needs exactly 4 players for this format.', missing;
    end if;
  end if;
  if ev.format = 'match_play' and sz = 1 then
    if exists (select 1 from public.session_assignments where event_id = p_event and match_slot is null) then
      raise exception 'Put every player in Match 1 or Match 2.';
    end if;
    if exists (
      select 1 from public.session_assignments where event_id = p_event
      group by session_id, match_slot having count(*) <> 2
    ) then
      raise exception 'Each match needs exactly 2 players.';
    end if;
  end if;

  update public.session_assignments a set
    index_used = p.handicap_index,
    course_handicap = round(public.nine_hole_course_handicap(p.handicap_index, ev.slope9, ev.course_rating9, ev.par9), 4),
    strokes = public.handicap_strokes(p.handicap_index, ev.slope9, ev.course_rating9, ev.par9),
    handicap_confirmed_at = now()
  from public.players p
  where p.id = a.player_id and a.event_id = p_event;

  if ev.format <> 'individual' then
    drop table if exists _plan;
    create temp table _plan (entry_id uuid, session_id uuid, team_id uuid, match_slot smallint, player_id uuid, ch numeric) on commit drop;
    if sz = 2 then
      insert into _plan
      select g.eid, a.session_id, g.tid, case when ev.format = 'match_play' then 1 end, a.player_id, a.course_handicap
      from (select gen_random_uuid() as eid, t.id as tid, t.player_a, t.player_b from public.teams t where t.season_year = ev.season_year) g
      join public.session_assignments a on a.event_id = p_event and a.player_id in (g.player_a, g.player_b);
    elsif sz = 4 then
      insert into _plan
      select g.eid, a.session_id, null, null, a.player_id, a.course_handicap
      from (select gen_random_uuid() as eid, s.id as sid from public.event_sessions s where s.event_id = p_event) g
      join public.session_assignments a on a.session_id = g.sid;
    else
      insert into _plan
      select gen_random_uuid(), a.session_id, null, a.match_slot, a.player_id, a.course_handicap
      from public.session_assignments a where a.event_id = p_event;
    end if;

    insert into public.event_entries (id, event_id, session_id, team_id, match_slot, strokes)
    select entry_id, p_event, session_id, team_id, match_slot,
           case when team_card then app_private.team_card_strokes(ev, array_agg(ch)) end
    from _plan group by entry_id, session_id, team_id, match_slot;

    insert into public.entry_members (entry_id, player_id, course_handicap, playing_handicap)
    select entry_id, player_id, ch,
           case when per_hole then app_private.round_half_up(ch * app_private.per_hole_allowance(ev)) end
    from _plan;

    if ev.format = 'match_play' then
      -- Strokes off the low player in each match.
      update public.entry_members m set playing_handicap = m.playing_handicap - x.low
      from public.event_entries e,
           (select e2.session_id, e2.match_slot, min(m2.playing_handicap) as low
              from public.entry_members m2 join public.event_entries e2 on e2.id = m2.entry_id
             where e2.event_id = p_event group by e2.session_id, e2.match_slot) x
      where e.id = m.entry_id and e.event_id = p_event and e.session_id = x.session_id and e.match_slot = x.match_slot;
    end if;
  end if;

  if team_card then
    insert into public.entry_round_scores (entry_id)
    select id from public.event_entries where event_id = p_event on conflict do nothing;
  else
    insert into public.round_scores (assignment_id)
    select id from public.session_assignments where event_id = p_event
    on conflict (assignment_id) do nothing;
  end if;

  update public.events set status = 'locked', locked_at = now() where id = p_event;
end;
$$;

create or replace function public.unlock_event(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform app_private.require_commissioner();
  perform set_config('jimulator.workflow', 'on', true);
  if (select status from public.events where id = p_event) <> 'locked' then
    raise exception 'Only a locked event can be unlocked.';
  end if;
  if exists (
    select 1 from public.round_scores r join public.session_assignments a on a.id = r.assignment_id
    where a.event_id = p_event and (r.status <> 'pending' or exists (select 1 from unnest(r.hole_scores) h where h is not null))
  ) or exists (
    select 1 from public.entry_round_scores r join public.event_entries e on e.id = r.entry_id
    where e.event_id = p_event and (r.status <> 'pending' or exists (select 1 from unnest(r.hole_scores) h where h is not null))
  ) then
    raise exception 'Scores have been entered, so the setup and handicaps stay locked.';
  end if;
  delete from public.round_scores r using public.session_assignments a where a.id = r.assignment_id and a.event_id = p_event;
  delete from public.event_entries where event_id = p_event;
  update public.session_assignments set index_used = null, course_handicap = null, strokes = null, handicap_confirmed_at = null
    where event_id = p_event;
  update public.event_sessions set status = 'scheduled', resolved_at = null where event_id = p_event;
  update public.events set status = 'draft', locked_at = null where id = p_event;
end;
$$;

create or replace function app_private.resolve_session_core(p_session uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  sess public.event_sessions;
  ev public.events;
  waiting text;
begin
  perform set_config('jimulator.workflow', 'on', true);
  select * into sess from public.event_sessions where id = p_session for update;
  select * into ev from public.events where id = sess.event_id;
  if ev.status <> 'locked' then raise exception 'Lock the event before completing a day.'; end if;
  if ev.format in ('scramble', 'alt_shot') then
    select string_agg(app_private.entry_label(e.id), ', ') into waiting
    from public.event_entries e
    left join public.entry_round_scores r on r.entry_id = e.id
    where e.session_id = p_session and coalesce(r.status, 'pending') = 'pending';
    if waiting is not null then
      raise exception 'Still waiting on: %. Mark each team completed, did not finish, or did not attend.', waiting;
    end if;
  else
    select string_agg(p.name, ', ') into waiting
    from public.session_assignments a
    join public.players p on p.id = a.player_id
    left join public.round_scores r on r.assignment_id = a.id
    where a.session_id = p_session and coalesce(r.status, 'pending') = 'pending';
    if waiting is not null then
      raise exception 'Still waiting on: %. Mark each player completed, did not finish, or did not attend.', waiting;
    end if;
  end if;
  update public.event_sessions set status = 'resolved', resolved_at = now() where id = p_session;
end;
$$;

-- ---------------------------------------------------------------------------
-- Publish
-- ---------------------------------------------------------------------------
create or replace function app_private.publish_event_core(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  ev public.events;
  basis text;
  field int;
  k int;
  st public.league_settings;
  pair record;
  sa text;
  sb text;
  margin int;
  winner uuid;
  forfeit boolean;
begin
  perform set_config('jimulator.workflow', 'on', true);
  select * into ev from public.events where id = p_event for update;
  if ev.status <> 'locked' then raise exception 'Only a locked event can be published.'; end if;
  if exists (select 1 from public.event_sessions where event_id = p_event and status <> 'resolved') then
    raise exception 'Complete every scheduled day before publishing.';
  end if;
  select * into st from public.league_settings where id = 1;
  basis := st.field_size_basis;

  if ev.format in ('scramble', 'alt_shot') then
    if exists (
      select 1 from public.event_entries e left join public.entry_round_scores r on r.entry_id = e.id
      where e.event_id = p_event and coalesce(r.status, 'pending') = 'pending'
    ) then
      raise exception 'Every team must be marked completed, did not finish, or did not attend.';
    end if;
  elsif exists (
    select 1 from public.session_assignments a left join public.round_scores r on r.assignment_id = a.id
    where a.event_id = p_event and coalesce(r.status, 'pending') = 'pending'
  ) then
    raise exception 'Every player must be marked completed, did not finish, or did not attend.';
  end if;

  -- ---- Individual stroke play --------------------------------------------
  if ev.format = 'individual' then
    select count(*) filter (where r.status = 'completed' or (basis = 'starters' and r.status = 'dnf'))
      into field
    from public.session_assignments a join public.round_scores r on r.assignment_id = a.id
    where a.event_id = p_event;
    if not exists (select 1 from public.points_tables where field_size = field) then
      raise exception 'No approved points table for a %-player field. The rules only define 4- and 8-player events, so the commissioner must resolve this before publishing.', field;
    end if;

    delete from public.event_results where event_id = p_event;
    with entries as (
      select a.player_id, s.session_number, r.status, a.strokes,
             (select sum(h) from unnest(r.hole_scores) h)::int as gross
      from public.session_assignments a
      join public.event_sessions s on s.id = a.session_id
      join public.round_scores r on r.assignment_id = a.id
      where a.event_id = p_event
    ),
    ranked as (
      select e.*, e.gross - e.strokes as net,
             rank() over (order by e.gross - e.strokes) as pos,
             count(*) over (partition by e.gross - e.strokes) as tie_count
      from entries e where e.status = 'completed'
    )
    insert into public.event_results (event_id, player_id, session_number, status, position, tied, gross, strokes, net, points)
    select p_event, r.player_id, r.session_number, r.status, r.pos, r.tie_count > 1, r.gross, r.strokes, r.net,
           round(coalesce((select sum(pt.points) from public.points_tables pt
                           where pt.field_size = field and pt.position between r.pos and r.pos + r.tie_count - 1), 0)
                 / r.tie_count, 2)
    from ranked r
    union all
    select p_event, e.player_id, e.session_number, e.status, null, false,
           case when e.status = 'dnf' then e.gross end, e.strokes, null, 0
    from entries e where e.status <> 'completed';

    update public.events set status = 'published', published_at = now() where id = p_event;
    return;
  end if;

  -- ---- Team and match formats: score each entry ----------------------------
  drop table if exists _scores;
    create temp table _scores (entry_id uuid, session_number int, team_id uuid, status text, gross int, net int, strokes int, size int) on commit drop;
  drop table if exists _holes;
    create temp table _holes (entry_id uuid, hole int, g int, n int, c int) on commit drop;

  if ev.format in ('scramble', 'alt_shot') then
    insert into _scores
    select e.id, s.session_number, e.team_id, r.status,
           (select sum(h) from unnest(r.hole_scores) h)::int,
           case when r.status = 'completed' then (select sum(h) from unnest(r.hole_scores) h)::int - e.strokes end,
           e.strokes,
           (select count(*) from public.entry_members x where x.entry_id = e.id)
    from public.event_entries e
    join public.event_sessions s on s.id = e.session_id
    join public.entry_round_scores r on r.entry_id = e.id
    where e.event_id = p_event;
  else
    k := case when ev.format = 'match_play' then 1 else ev.counting_scores end;
    insert into _holes
    with mh as (
      select m.entry_id, u.hole::int as hole, u.g::int as g,
             (u.g - public.hole_strokes(coalesce(m.playing_handicap, 0), app_private.si_rank(ev.hole_si, u.hole::int)))::int as n
      from public.entry_members m
      join public.event_entries e on e.id = m.entry_id and e.event_id = p_event
      join public.session_assignments a on a.event_id = p_event and a.player_id = m.player_id
      join public.round_scores rs on rs.assignment_id = a.id and rs.status <> 'dna'
      cross join lateral unnest(rs.hole_scores) with ordinality as u(g, hole)
      where u.g is not null
    ),
    best as (
      select mh.*, row_number() over (partition by entry_id, hole order by n, g) as rn from mh
    )
    select entry_id, hole, sum(g)::int, sum(n)::int, count(*)::int from best where rn <= k group by entry_id, hole;

    insert into _scores
    select e.id, s.session_number, e.team_id,
           case
             when not exists (
               select 1 from public.entry_members m
               join public.session_assignments a on a.event_id = p_event and a.player_id = m.player_id
               join public.round_scores rs on rs.assignment_id = a.id
               where m.entry_id = e.id and rs.status <> 'dna') then 'dna'
             when (select count(*) from _holes h where h.entry_id = e.id and h.c = k) = 9 then 'completed'
             else 'dnf'
           end,
           null, null, null,
           (select count(*) from public.entry_members x where x.entry_id = e.id)
    from public.event_entries e
    join public.event_sessions s on s.id = e.session_id
    where e.event_id = p_event;
    update _scores x set gross = (select sum(h.g) from _holes h where h.entry_id = x.entry_id),
                         net = (select sum(h.n) from _holes h where h.entry_id = x.entry_id)
    where x.status = 'completed';
  end if;

  delete from public.event_results where event_id = p_event;

  -- ---- Match play ------------------------------------------------------------
  if ev.format = 'match_play' then
    if st.match_win_points is null or st.match_halve_points is null then
      raise exception 'Set the match play points for a win and a halve in the league office.';
    end if;
    drop table if exists _match;
    create temp table _match (entry_id uuid, points numeric, detail text) on commit drop;
    for pair in
      select e1.id as a, e2.id as b from public.event_entries e1
      join public.event_entries e2 on e2.event_id = e1.event_id and e2.session_id = e1.session_id
        and e2.match_slot = e1.match_slot and e1.id::text < e2.id::text
      where e1.event_id = p_event
    loop
      select status into sa from _scores where entry_id = pair.a;
      select status into sb from _scores where entry_id = pair.b;
      winner := null; margin := 0; forfeit := false;
      if sa = 'completed' and sb = 'completed' then
        select coalesce(sum(sign(hb.n - ha.n)), 0) into margin
        from _holes ha join _holes hb on hb.hole = ha.hole and hb.entry_id = pair.b where ha.entry_id = pair.a;
        winner := case when margin > 0 then pair.a when margin < 0 then pair.b end;
        margin := abs(margin);
      elsif (sa = 'completed') <> (sb = 'completed') then
        winner := case when sa = 'completed' then pair.a else pair.b end;
        forfeit := true;
      end if;
      insert into _match values
        (pair.a,
         case when winner = pair.a then st.match_win_points when winner is null and sa = 'completed' and sb = 'completed' then st.match_halve_points else 0 end,
         case when winner = pair.a then case when forfeit then 'Won by forfeit vs ' else 'Won ' || margin || ' up vs ' end || app_private.entry_label(pair.b)
              when winner = pair.b then case when forfeit then 'Lost by forfeit to ' else 'Lost ' || margin || ' down to ' end || app_private.entry_label(pair.b)
              when sa = 'completed' and sb = 'completed' then 'Halved with ' || app_private.entry_label(pair.b)
              else 'No result vs ' || app_private.entry_label(pair.b) end),
        (pair.b,
         case when winner = pair.b then st.match_win_points when winner is null and sa = 'completed' and sb = 'completed' then st.match_halve_points else 0 end,
         case when winner = pair.b then case when forfeit then 'Won by forfeit vs ' else 'Won ' || margin || ' up vs ' end || app_private.entry_label(pair.a)
              when winner = pair.a then case when forfeit then 'Lost by forfeit to ' else 'Lost ' || margin || ' down to ' end || app_private.entry_label(pair.a)
              when sa = 'completed' and sb = 'completed' then 'Halved with ' || app_private.entry_label(pair.a)
              else 'No result vs ' || app_private.entry_label(pair.a) end);
    end loop;

    insert into public.event_results (event_id, player_id, team_id, entry_id, session_number, status, position, tied, gross, strokes, net, points, detail)
    select p_event, mem.player_id, x.team_id, x.entry_id, x.session_number, rs.status, null, false,
           case when rs.status = 'completed' then (select sum(h) from unnest(rs.hole_scores) h)::int end,
           mem.playing_handicap,
           case when rs.status = 'completed' then
             (select sum(u.g - public.hole_strokes(coalesce(mem.playing_handicap, 0), app_private.si_rank(ev.hole_si, u.hole::int)))
                from unnest(rs.hole_scores) with ordinality as u(g, hole))::int end,
           coalesce(mt.points, 0), coalesce(mt.detail, 'No opponent')
    from _scores x
    join public.entry_members mem on mem.entry_id = x.entry_id
    join public.session_assignments a on a.event_id = p_event and a.player_id = mem.player_id
    join public.round_scores rs on rs.assignment_id = a.id
    left join _match mt on mt.entry_id = x.entry_id;

    update public.events set status = 'published', published_at = now() where id = p_event;
    return;
  end if;

  -- ---- Team leaderboard: average of the places each team fills ----------------
  select coalesce(sum(size), 0) into field from _scores
  where status = 'completed' or (basis = 'starters' and status = 'dnf');
  if not exists (select 1 from public.points_tables where field_size = field) then
    raise exception 'No approved points table for a %-player field. The rules only define 4- and 8-player events, so the commissioner must resolve this before publishing.', field;
  end if;

  with fin as (
    select x.*, rank() over (order by x.net) as pos from _scores x where x.status = 'completed'
  ),
  grp as (
    select net, sum(size)::int as places, count(*)::int as n from fin group by net
  ),
  cum as (
    select net, places, n, (sum(places) over (order by net) - places + 1)::int as first_place from grp
  )
  insert into public.event_results (event_id, player_id, team_id, entry_id, session_number, status, position, tied, gross, strokes, net, points)
  select p_event, mem.player_id, f.team_id, f.entry_id, f.session_number, 'completed', f.pos, c.n > 1, f.gross, f.strokes, f.net,
         round(coalesce((select sum(pt.points) from public.points_tables pt
                         where pt.field_size = field and pt.position between c.first_place and c.first_place + c.places - 1), 0)
               / c.places, 2)
  from fin f
  join cum c on c.net = f.net
  join public.entry_members mem on mem.entry_id = f.entry_id
  union all
  select p_event, mem.player_id, x.team_id, x.entry_id, x.session_number, x.status, null, false,
         case when x.status = 'dna' then null else x.gross end, x.strokes, null, 0
  from _scores x
  join public.entry_members mem on mem.entry_id = x.entry_id
  where x.status <> 'completed';

  update public.events set status = 'published', published_at = now() where id = p_event;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security and grants
-- ---------------------------------------------------------------------------
alter table public.event_entries enable row level security;
alter table public.entry_members enable row level security;
alter table public.entry_round_scores enable row level security;

create policy "anyone reads entries" on public.event_entries for select using (true);
create policy "anyone reads entry members" on public.entry_members for select using (true);
create policy "entry scores private until published" on public.entry_round_scores for select using (
  public.is_commissioner() or exists (
    select 1 from public.event_entries e join public.events v on v.id = e.event_id
    where e.id = entry_round_scores.entry_id and v.status = 'published'
  )
);
create policy "commissioner enters team scores" on public.entry_round_scores for insert with check (public.is_commissioner());
create policy "commissioner edits team scores" on public.entry_round_scores for update using (public.is_commissioner());

grant select on public.event_entries, public.entry_members, public.entry_round_scores to anon, authenticated;
grant insert, update on public.entry_round_scores to authenticated;
grant execute on function public.hole_strokes(int, int) to anon, authenticated;

revoke execute on function app_private.lock_event_core(uuid), app_private.resolve_session_core(uuid),
  app_private.publish_event_core(uuid), app_private.round_half_up(numeric), app_private.si_rank(smallint[], int),
  app_private.entry_size(public.events), app_private.team_card_strokes(public.events, numeric[]),
  app_private.per_hole_allowance(public.events), app_private.entry_label(uuid)
  from public, anon, authenticated;
grant execute on function app_private.entries_guard(), app_private.entry_round_scores_guard(), app_private.events_guard()
  to anon, authenticated;

select set_config('jimulator.workflow', 'off', false);
