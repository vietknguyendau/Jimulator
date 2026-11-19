-- 2-person team scramble.
-- Each event is Individual or Scramble (the commissioner picks while setting it up).
-- Teams are fixed for the season. In a scramble event both teammates play the same
-- session, the team turns in one 9-hole card, and team handicap strokes are
-- 35% of the lower + 15% of the higher 9-hole Course Handicap, rounded once.
-- Teams are ranked on one combined leaderboard by net; the points table is chosen by
-- the number of teams, and every teammate earns the team's points.

alter table public.events
  add column format text not null default 'individual' check (format in ('individual', 'scramble'));

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
    or new.season_year is distinct from old.season_year
    or new.event_number is distinct from old.event_number) then
    raise exception 'This event''s setup is locked. Unlock it before changing the format, course, tees or simulator settings.';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Season teams
-- ---------------------------------------------------------------------------
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  season_year int not null,
  name text not null check (length(trim(name)) > 0),
  player_a uuid not null references public.players (id),
  player_b uuid not null references public.players (id),
  created_at timestamptz not null default now(),
  check (player_a <> player_b)
);

create or replace function app_private.teams_guard()
returns trigger
language plpgsql
as $$
declare
  other text;
begin
  perform 1 from public.teams where season_year = new.season_year for update;
  if tg_op = 'INSERT' and (select count(*) from public.teams where season_year = new.season_year) >= 4 then
    raise exception 'The league has at most 4 two-person teams.' using errcode = 'check_violation';
  end if;
  select t.name into other from public.teams t
  where t.season_year = new.season_year and t.id <> new.id
    and (new.player_a in (t.player_a, t.player_b) or new.player_b in (t.player_a, t.player_b));
  if found then
    raise exception 'A player can be on only one team per season (already on %).', other using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

create trigger teams_guard
  before insert or update on public.teams
  for each row execute function app_private.teams_guard();

-- ---------------------------------------------------------------------------
-- A team's entry in a scramble event: filled when the event is locked
-- ---------------------------------------------------------------------------
create table public.event_teams (
  event_id uuid not null references public.events (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  session_id uuid not null references public.event_sessions (id) on delete cascade,
  player_a uuid not null references public.players (id),
  player_b uuid not null references public.players (id),
  ch_a numeric(8, 4) not null,
  ch_b numeric(8, 4) not null,
  strokes int not null,
  confirmed_at timestamptz not null default now(),
  primary key (event_id, team_id)
);

create or replace function app_private.event_teams_guard()
returns trigger
language plpgsql
as $$
begin
  if not app_private.in_workflow() then
    raise exception 'Teams are entered into an event when it is locked.';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger event_teams_guard
  before insert or update or delete on public.event_teams
  for each row execute function app_private.event_teams_guard();

-- One scorecard per team; private until the event is published.
create table public.team_round_scores (
  event_id uuid not null,
  team_id uuid not null,
  hole_scores smallint[] not null default array[null,null,null,null,null,null,null,null,null]::smallint[],
  status text not null default 'pending' check (status in ('pending', 'completed', 'dnf', 'dna')),
  updated_at timestamptz not null default now(),
  primary key (event_id, team_id),
  foreign key (event_id, team_id) references public.event_teams (event_id, team_id) on delete cascade,
  constraint nine_holes check (array_length(hole_scores, 1) = 9),
  constraint sane_hole_scores check (1 <= all (hole_scores) and 20 >= all (hole_scores))
);

create or replace function app_private.team_round_scores_guard()
returns trigger
language plpgsql
as $$
declare
  ev public.events;
  sess public.event_sessions;
  holes int;
begin
  select * into ev from public.events where id = new.event_id;
  select s.* into sess from public.event_sessions s join public.event_teams et on et.session_id = s.id
  where et.event_id = new.event_id and et.team_id = new.team_id;
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

create trigger team_round_scores_guard
  before insert or update on public.team_round_scores
  for each row execute function app_private.team_round_scores_guard();

alter table public.event_results add column team_id uuid references public.teams (id);

create or replace function public.scramble_strokes(ch_a numeric, ch_b numeric)
returns int
language sql
immutable
as $$
  select floor(round(least(ch_a, ch_b) * 0.35 + greatest(ch_a, ch_b) * 0.15, 6) + 0.5)::int;
$$;

-- ---------------------------------------------------------------------------
-- Workflow functions, now format-aware
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

  if ev.format = 'scramble' then
    select string_agg(p.name, ', ') into missing
    from public.session_assignments a join public.players p on p.id = a.player_id
    where a.event_id = p_event and not exists (
      select 1 from public.teams t where t.season_year = ev.season_year and a.player_id in (t.player_a, t.player_b));
    if missing is not null then
      raise exception 'Not on a scramble team: %. Add them to a team first.', missing;
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

  update public.session_assignments a set
    index_used = p.handicap_index,
    course_handicap = round(public.nine_hole_course_handicap(p.handicap_index, ev.slope9, ev.course_rating9, ev.par9), 4),
    strokes = public.handicap_strokes(p.handicap_index, ev.slope9, ev.course_rating9, ev.par9),
    handicap_confirmed_at = now()
  from public.players p
  where p.id = a.player_id and a.event_id = p_event;

  if ev.format = 'scramble' then
    insert into public.event_teams (event_id, team_id, session_id, player_a, player_b, ch_a, ch_b, strokes)
    select p_event, t.id, a1.session_id, t.player_a, t.player_b, a1.course_handicap, a2.course_handicap,
           public.scramble_strokes(a1.course_handicap, a2.course_handicap)
    from public.teams t
    join public.session_assignments a1 on a1.event_id = p_event and a1.player_id = t.player_a
    join public.session_assignments a2 on a2.event_id = p_event and a2.player_id = t.player_b
    where t.season_year = ev.season_year;
    insert into public.team_round_scores (event_id, team_id)
    select event_id, team_id from public.event_teams where event_id = p_event
    on conflict do nothing;
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
    select 1 from public.team_round_scores r
    where r.event_id = p_event and (r.status <> 'pending' or exists (select 1 from unnest(r.hole_scores) h where h is not null))
  ) then
    raise exception 'Scores have been entered, so the setup and handicaps stay locked.';
  end if;
  delete from public.round_scores r using public.session_assignments a where a.id = r.assignment_id and a.event_id = p_event;
  delete from public.event_teams where event_id = p_event;
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
  if ev.format = 'scramble' then
    select string_agg(t.name, ', ') into waiting
    from public.event_teams et
    join public.teams t on t.id = et.team_id
    left join public.team_round_scores r on r.event_id = et.event_id and r.team_id = et.team_id
    where et.session_id = p_session and coalesce(r.status, 'pending') = 'pending';
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
  select field_size_basis into basis from public.league_settings where id = 1;

  if ev.format = 'scramble' then
    if exists (
      select 1 from public.event_teams et left join public.team_round_scores r on r.event_id = et.event_id and r.team_id = et.team_id
      where et.event_id = p_event and coalesce(r.status, 'pending') = 'pending'
    ) then
      raise exception 'Every team must be marked completed, did not finish, or did not attend.';
    end if;
    select count(*) filter (where r.status = 'completed' or (basis = 'starters' and r.status = 'dnf'))
      into field
    from public.team_round_scores r where r.event_id = p_event;
    if not exists (select 1 from public.points_tables where field_size = field) then
      raise exception 'No approved points table for a %-team scramble. The rules only define 4- and 8-entry tables, so the commissioner must resolve this before publishing.', field;
    end if;

    delete from public.event_results where event_id = p_event;
    with entries as (
      select et.team_id, et.player_a, et.player_b, s.session_number, r.status, et.strokes,
             (select sum(h) from unnest(r.hole_scores) h)::int as gross
      from public.event_teams et
      join public.event_sessions s on s.id = et.session_id
      join public.team_round_scores r on r.event_id = et.event_id and r.team_id = et.team_id
      where et.event_id = p_event
    ),
    ranked as (
      select e.*, e.gross - e.strokes as net,
             rank() over (order by e.gross - e.strokes) as pos,
             count(*) over (partition by e.gross - e.strokes) as tie_count
      from entries e where e.status = 'completed'
    ),
    team_results as (
      select r.team_id, r.player_a, r.player_b, r.session_number, r.status, r.pos as position, r.tie_count > 1 as tied,
             r.gross, r.strokes, r.net,
             round(coalesce((select sum(pt.points) from public.points_tables pt
                             where pt.field_size = field and pt.position between r.pos and r.pos + r.tie_count - 1), 0)
                   / r.tie_count, 2) as points
      from ranked r
      union all
      select e.team_id, e.player_a, e.player_b, e.session_number, e.status, null, false,
             case when e.status = 'dnf' then e.gross end, e.strokes, null, 0
      from entries e where e.status <> 'completed'
    )
    insert into public.event_results (event_id, player_id, team_id, session_number, status, position, tied, gross, strokes, net, points)
    select p_event, pl.player_id, tr.team_id, tr.session_number, tr.status, tr.position, tr.tied, tr.gross, tr.strokes, tr.net, tr.points
    from team_results tr
    cross join lateral (values (tr.player_a), (tr.player_b)) as pl (player_id);
  else
    if exists (
      select 1 from public.session_assignments a left join public.round_scores r on r.assignment_id = a.id
      where a.event_id = p_event and coalesce(r.status, 'pending') = 'pending'
    ) then
      raise exception 'Every player must be marked completed, did not finish, or did not attend.';
    end if;
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
  end if;

  update public.events set status = 'published', published_at = now() where id = p_event;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security and grants
-- ---------------------------------------------------------------------------
alter table public.teams enable row level security;
alter table public.event_teams enable row level security;
alter table public.team_round_scores enable row level security;

create policy "anyone reads teams" on public.teams for select using (true);
create policy "commissioner adds teams" on public.teams for insert with check (public.is_commissioner());
create policy "commissioner edits teams" on public.teams for update using (public.is_commissioner());
create policy "commissioner removes teams" on public.teams for delete using (public.is_commissioner());

create policy "anyone reads event teams" on public.event_teams for select using (true);

create policy "team scores private until published" on public.team_round_scores for select using (
  public.is_commissioner() or exists (
    select 1 from public.events e where e.id = team_round_scores.event_id and e.status = 'published'
  )
);
create policy "commissioner enters team scores" on public.team_round_scores for insert with check (public.is_commissioner());
create policy "commissioner edits team scores" on public.team_round_scores for update using (public.is_commissioner());

grant select on public.teams, public.event_teams, public.team_round_scores to anon, authenticated;
grant insert, update, delete on public.teams to authenticated;
grant insert, update on public.team_round_scores to authenticated;
grant execute on function public.scramble_strokes(numeric, numeric) to anon, authenticated;

revoke execute on function app_private.lock_event_core(uuid), app_private.resolve_session_core(uuid),
  app_private.publish_event_core(uuid) from public, anon, authenticated;
grant execute on function app_private.teams_guard(), app_private.event_teams_guard(), app_private.team_round_scores_guard(),
  app_private.events_guard() to anon, authenticated;
