-- Event workflow: lock setup + confirm handicaps, resolve sessions, publish one
-- combined result per event. The *_core functions hold the rules; the public
-- functions check that the caller is the commissioner and then call them.

create table public.event_results (
  event_id uuid not null references public.events (id) on delete cascade,
  player_id uuid not null references public.players (id),
  session_number smallint not null,
  status text not null check (status in ('completed', 'dnf', 'dna')),
  position int,
  tied boolean not null default false,
  gross int,
  strokes int,
  net int,
  points numeric(5, 2) not null default 0,
  primary key (event_id, player_id)
);

alter table public.event_results enable row level security;
-- Rows only exist once results are official.
create policy "anyone reads official results" on public.event_results for select using (true);

-- ---------------------------------------------------------------------------
-- Handicap: WHS 9-hole Course Handicap, 80% allowance, rounded once (halves up)
-- ---------------------------------------------------------------------------
create or replace function public.nine_hole_course_handicap(idx numeric, slope9 int, rating9 numeric, par9 int)
returns numeric
language sql
immutable
as $$
  select (idx / 2) * (slope9::numeric / 113) + (rating9 - par9);
$$;

create or replace function public.handicap_strokes(idx numeric, slope9 int, rating9 numeric, par9 int)
returns int
language sql
immutable
as $$
  select floor(round(public.nine_hole_course_handicap(idx, slope9, rating9, par9) * 0.8, 6) + 0.5)::int;
$$;

-- ---------------------------------------------------------------------------
-- Commissioner guard
-- ---------------------------------------------------------------------------
create or replace function app_private.require_commissioner()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_commissioner() then
    raise exception 'Only the commissioner can do that.' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock event setup and confirm every assigned player's handicap
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
  missing text;
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

  update public.session_assignments a set
    index_used = p.handicap_index,
    course_handicap = round(public.nine_hole_course_handicap(p.handicap_index, ev.slope9, ev.course_rating9, ev.par9), 4),
    strokes = public.handicap_strokes(p.handicap_index, ev.slope9, ev.course_rating9, ev.par9),
    handicap_confirmed_at = now()
  from public.players p
  where p.id = a.player_id and a.event_id = p_event;

  insert into public.round_scores (assignment_id)
  select id from public.session_assignments where event_id = p_event
  on conflict (assignment_id) do nothing;

  update public.events set status = 'locked', locked_at = now() where id = p_event;
end;
$$;

create or replace function public.lock_event(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform app_private.require_commissioner();
  perform app_private.lock_event_core(p_event);
end;
$$;

-- Only before any score is entered.
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
  ) then
    raise exception 'Scores have been entered, so the setup and handicaps stay locked.';
  end if;
  delete from public.round_scores r using public.session_assignments a where a.id = r.assignment_id and a.event_id = p_event;
  update public.session_assignments set index_used = null, course_handicap = null, strokes = null, handicap_confirmed_at = null
    where event_id = p_event;
  update public.event_sessions set status = 'scheduled', resolved_at = null where event_id = p_event;
  update public.events set status = 'draft', locked_at = null where id = p_event;
end;
$$;

-- ---------------------------------------------------------------------------
-- Resolve a session: every player in it is completed, DNF or did not attend
-- ---------------------------------------------------------------------------
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
  select string_agg(p.name, ', ') into waiting
  from public.session_assignments a
  join public.players p on p.id = a.player_id
  left join public.round_scores r on r.assignment_id = a.id
  where a.session_id = p_session and coalesce(r.status, 'pending') = 'pending';
  if waiting is not null then
    raise exception 'Still waiting on: %. Mark each player completed, did not finish, or did not attend.', waiting;
  end if;
  update public.event_sessions set status = 'resolved', resolved_at = now() where id = p_session;
end;
$$;

create or replace function public.resolve_session(p_session uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform app_private.require_commissioner();
  perform app_private.resolve_session_core(p_session);
end;
$$;

create or replace function public.reopen_session(p_session uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform app_private.require_commissioner();
  perform set_config('jimulator.workflow', 'on', true);
  if (select e.status from public.events e join public.event_sessions s on s.event_id = e.id where s.id = p_session) = 'published' then
    raise exception 'Unpublish the results before reopening a day.';
  end if;
  update public.event_sessions set status = 'scheduled', resolved_at = null where id = p_session;
end;
$$;

-- ---------------------------------------------------------------------------
-- Publish: one combined leaderboard by net score, points awarded once
-- ---------------------------------------------------------------------------
create or replace function app_private.publish_event_core(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  ev public.events;
  basis text;
  field int;
begin
  perform set_config('jimulator.workflow', 'on', true);
  select * into ev from public.events where id = p_event for update;
  if ev.status <> 'locked' then raise exception 'Only a locked event can be published.'; end if;
  if exists (select 1 from public.event_sessions where event_id = p_event and status <> 'resolved') then
    raise exception 'Complete every scheduled day before publishing.';
  end if;
  if exists (
    select 1 from public.session_assignments a left join public.round_scores r on r.assignment_id = a.id
    where a.event_id = p_event and coalesce(r.status, 'pending') = 'pending'
  ) then
    raise exception 'Every player must be marked completed, did not finish, or did not attend.';
  end if;

  select field_size_basis into basis from public.league_settings where id = 1;
  select count(*) filter (where r.status = 'completed' or (basis = 'starters' and r.status = 'dnf'))
    into field
  from public.session_assignments a join public.round_scores r on r.assignment_id = a.id
  where a.event_id = p_event;

  -- Unresolved policy: only 4- and 8-player fields have an approved table.
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
end;
$$;

create or replace function public.publish_event(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform app_private.require_commissioner();
  perform app_private.publish_event_core(p_event);
end;
$$;

-- Take results back down to correct a score. Scores become private again.
create or replace function public.unpublish_event(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform app_private.require_commissioner();
  perform set_config('jimulator.workflow', 'on', true);
  if (select status from public.events where id = p_event) <> 'published' then
    raise exception 'This event is not published.';
  end if;
  delete from public.event_results where event_id = p_event;
  update public.events set status = 'locked', published_at = null where id = p_event;
end;
$$;

-- ---------------------------------------------------------------------------
-- New season: always exactly five championship events
-- ---------------------------------------------------------------------------
create or replace function app_private.create_season_core(p_year int)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.events (season_year, event_number, name)
  select p_year, n, 'Event ' || n from generate_series(1, 5) n
  on conflict (season_year, event_number) do nothing;
end;
$$;

create or replace function public.start_season(p_year int)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform app_private.require_commissioner();
  perform app_private.create_season_core(p_year);
  perform set_config('jimulator.workflow', 'on', true);
  update public.league_settings set season_year = p_year, updated_at = now() where id = 1;
end;
$$;

revoke execute on all functions in schema app_private from public;
revoke execute on function public.lock_event(uuid), public.unlock_event(uuid), public.resolve_session(uuid),
  public.reopen_session(uuid), public.publish_event(uuid), public.unpublish_event(uuid), public.start_season(int) from public, anon;
grant execute on function public.lock_event(uuid), public.unlock_event(uuid), public.resolve_session(uuid),
  public.reopen_session(uuid), public.publish_event(uuid), public.unpublish_event(uuid), public.start_season(int) to authenticated;

-- Guard triggers run as the caller and need their helpers; the *_core rule functions stay private.
grant usage on schema app_private to anon, authenticated;
grant execute on function app_private.in_workflow(), app_private.players_max_eight(), app_private.events_guard(),
  app_private.event_sessions_guard(), app_private.session_assignments_guard(), app_private.round_scores_guard()
  to anon, authenticated;
