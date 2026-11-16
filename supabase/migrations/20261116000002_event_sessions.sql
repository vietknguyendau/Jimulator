-- Sessions: one or two child records per event. A session is one group of up to
-- four players on the single simulator. Day 2 must be the calendar day after Day 1
-- in the league time zone (America/Chicago); session_date is stored as that local date.

create table public.event_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  session_number smallint not null check (session_number in (1, 2)),
  session_date date not null,
  start_time time not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'resolved')),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, session_number),
  unique (id, event_id)
);

create index event_sessions_event_idx on public.event_sessions (event_id);

-- Real start instant, for display and "has it started yet" checks.
create or replace function public.session_starts_at(s public.event_sessions)
returns timestamptz
language sql
stable
as $$
  select (s.session_date + s.start_time) at time zone 'America/Chicago';
$$;

create or replace function app_private.event_sessions_guard()
returns trigger
language plpgsql
as $$
declare
  ev public.events;
  other public.event_sessions;
begin
  if tg_op = 'DELETE' then
    select * into ev from public.events where id = old.event_id;
    if ev.status <> 'draft' and not app_private.in_workflow() then
      raise exception 'Unlock the event before removing a session.';
    end if;
    if old.session_number = 1 and exists (
      select 1 from public.event_sessions where event_id = old.event_id and session_number = 2
    ) then
      raise exception 'Remove Day 2 before removing Day 1.';
    end if;
    if exists (select 1 from public.session_assignments where session_id = old.id) then
      raise exception 'Move or remove this session''s players first.';
    end if;
    return old;
  end if;

  select * into ev from public.events where id = new.event_id for update;

  if not app_private.in_workflow() then
    if tg_op = 'INSERT' and ev.status <> 'draft' then
      raise exception 'Unlock the event before adding a session.';
    end if;
    if tg_op = 'UPDATE' and (new.status is distinct from old.status or new.resolved_at is distinct from old.resolved_at) then
      raise exception 'Use Resolve or Reopen to change a session''s status.';
    end if;
    if tg_op = 'UPDATE' and (new.event_id <> old.event_id or new.session_number <> old.session_number) then
      raise exception 'A session cannot move to another event or day number.';
    end if;
    if ev.status = 'published' then
      raise exception 'Results are published; this event can no longer be rescheduled.';
    end if;
  end if;

  if new.session_number = 2 then
    select * into other from public.event_sessions where event_id = new.event_id and session_number = 1;
    if not found then
      raise exception 'Schedule Day 1 before adding Day 2.';
    end if;
    if new.session_date <> other.session_date + 1 then
      raise exception 'Day 2 must be the day after Day 1 (%, Central time).', other.session_date + 1
        using errcode = 'check_violation';
    end if;
  else
    select * into other from public.event_sessions where event_id = new.event_id and session_number = 2;
    if found and other.session_date <> new.session_date + 1 then
      raise exception 'Day 2 is set for %, so Day 1 must be %. Move or remove Day 2 first.',
        other.session_date, other.session_date - 1 using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger event_sessions_guard
  before insert or update or delete on public.event_sessions
  for each row execute function app_private.event_sessions_guard();

-- ---------------------------------------------------------------------------
-- Assignments: each player plays one session per event; four per session max.
-- Handicap snapshot columns are filled when the event is locked.
-- ---------------------------------------------------------------------------
create table public.session_assignments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  session_id uuid not null,
  player_id uuid not null references public.players (id),
  index_used numeric(3, 1),
  course_handicap numeric(8, 4),
  strokes int,
  handicap_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (session_id, event_id) references public.event_sessions (id, event_id) on delete cascade,
  constraint one_session_per_player_per_event unique (event_id, player_id)
);

create index session_assignments_session_idx on public.session_assignments (session_id);

create or replace function app_private.session_assignments_guard()
returns trigger
language plpgsql
as $$
declare
  ev public.events;
  sess public.event_sessions;
  existing_day smallint;
  n int;
begin
  if tg_op = 'DELETE' then
    select * into ev from public.events where id = old.event_id;
    if ev.status <> 'draft' and not app_private.in_workflow() then
      raise exception 'Unlock the event before changing groups.';
    end if;
    return old;
  end if;

  -- Serialize assignment changes per event so two saves can't both take the 4th spot.
  select * into ev from public.events where id = new.event_id for update;

  if not app_private.in_workflow() then
    if ev.status <> 'draft' then
      raise exception 'Unlock the event before changing groups.';
    end if;
    if tg_op = 'INSERT' and (new.index_used is not null or new.strokes is not null or new.handicap_confirmed_at is not null) then
      raise exception 'Handicaps are set when the event is locked.';
    end if;
    if tg_op = 'UPDATE' and (
         new.index_used is distinct from old.index_used
      or new.course_handicap is distinct from old.course_handicap
      or new.strokes is distinct from old.strokes
      or new.handicap_confirmed_at is distinct from old.handicap_confirmed_at) then
      raise exception 'Handicaps are set when the event is locked.';
    end if;
  end if;

  select * into sess from public.event_sessions where id = new.session_id and event_id = new.event_id;
  if not found then
    raise exception 'That session does not belong to this event.';
  end if;

  select s.session_number into existing_day
  from public.session_assignments a join public.event_sessions s on s.id = a.session_id
  where a.event_id = new.event_id and a.player_id = new.player_id and a.id <> new.id;
  if found then
    raise exception 'That player is already assigned to Day %. A player can play only one session per event.', existing_day
      using errcode = 'unique_violation';
  end if;

  if tg_op = 'INSERT' or new.session_id <> old.session_id then
    select count(*) into n from public.session_assignments where session_id = new.session_id and id <> new.id;
    if n >= 4 then
      raise exception 'Day % already has 4 players, the most one simulator session can hold.', sess.session_number
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger session_assignments_guard
  before insert or update or delete on public.session_assignments
  for each row execute function app_private.session_assignments_guard();

-- ---------------------------------------------------------------------------
-- Round scores: private until the event's results are published.
-- Saved as the commissioner enters them, so Day 1 survives sign-out.
-- ---------------------------------------------------------------------------
create table public.round_scores (
  assignment_id uuid primary key references public.session_assignments (id) on delete cascade,
  hole_scores smallint[] not null default array[null,null,null,null,null,null,null,null,null]::smallint[],
  status text not null default 'pending' check (status in ('pending', 'completed', 'dnf', 'dna')),
  updated_at timestamptz not null default now(),
  constraint nine_holes check (array_length(hole_scores, 1) = 9),
  -- Empty holes are null; entered holes are 1..20 strokes.
  constraint sane_hole_scores check (1 <= all (hole_scores) and 20 >= all (hole_scores))
);

create or replace function app_private.round_scores_guard()
returns trigger
language plpgsql
as $$
declare
  ev public.events;
  sess public.event_sessions;
  holes int;
begin
  select e.* into ev from public.events e join public.session_assignments a on a.event_id = e.id
  where a.id = new.assignment_id;
  select s.* into sess from public.event_sessions s join public.session_assignments a on a.session_id = s.id
  where a.id = new.assignment_id;

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
    raise exception 'A player must finish all 9 holes to be marked completed.';
  end if;
  if new.status = 'dna' and holes > 0 then
    raise exception 'A player who did not attend can''t have hole scores.';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger round_scores_guard
  before insert or update on public.round_scores
  for each row execute function app_private.round_scores_guard();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.event_sessions enable row level security;
alter table public.session_assignments enable row level security;
alter table public.round_scores enable row level security;

-- Session dates and groups are public; that's the schedule.
create policy "anyone reads sessions" on public.event_sessions for select using (true);
create policy "commissioner adds sessions" on public.event_sessions for insert with check (public.is_commissioner());
create policy "commissioner edits sessions" on public.event_sessions for update using (public.is_commissioner());
create policy "commissioner removes sessions" on public.event_sessions for delete using (public.is_commissioner());

create policy "anyone reads groups" on public.session_assignments for select using (true);
create policy "commissioner assigns" on public.session_assignments for insert with check (public.is_commissioner());
create policy "commissioner reassigns" on public.session_assignments for update using (public.is_commissioner());
create policy "commissioner unassigns" on public.session_assignments for delete using (public.is_commissioner());

-- Scores: commissioner always; everyone else only once official results are published.
create policy "scores private until published" on public.round_scores for select using (
  public.is_commissioner() or exists (
    select 1 from public.session_assignments a join public.events e on e.id = a.event_id
    where a.id = round_scores.assignment_id and e.status = 'published'
  )
);
create policy "commissioner enters scores" on public.round_scores for insert with check (public.is_commissioner());
create policy "commissioner edits scores" on public.round_scores for update using (public.is_commissioner());
