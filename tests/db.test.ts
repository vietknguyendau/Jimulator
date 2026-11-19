// Runs the real migrations + seed in PGlite (Postgres in WASM) with a stand-in for
// Supabase's auth schema, then exercises the rules as the commissioner and the public.
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedSql } from '../scripts/generate-seed';
import { buildDemoSnapshot, demoIds } from '../src/data/demoSeed';
import { computeOutcome, planEntries, teamCardStrokes } from '../src/lib/formats';
import type { EventFormat, Snapshot } from '../src/lib/types';

const ROOT = join(__dirname, '..');
const COMMISH = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
`;

let db: PGlite;

/** Supabase runs signed-in users as `authenticated` with their user id in the JWT; everyone else is `anon`. */
async function as(who: 'commissioner' | 'public' | 'stranger', sql: string, params: unknown[] = []) {
  const role = who === 'public' ? 'anon' : 'authenticated';
  const sub = who === 'commissioner' ? COMMISH : who === 'stranger' ? STRANGER : '';
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
    await tx.exec(`set local role ${role}`);
    return tx.query<Record<string, unknown>>(sql, params);
  });
}
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected an error');
};

/** Fresh event 4 with Day 1 and Day 2, for rule tests. */
async function setupEvent4(day1: string, day2?: string) {
  const ev = demoIds.eid(4);
  // Clear the demo's best-ball setup: these tests want a plain individual event.
  await as('commissioner', `delete from session_assignments where event_id=$1`, [ev]);
  await as('commissioner', `delete from event_sessions where event_id=$1 and session_number=2`, [ev]);
  await as('commissioner', `delete from event_sessions where event_id=$1`, [ev]);
  await as('commissioner', `update events set format='individual', course_name='Test Links', tees='White', par9=36, course_rating9=36, slope9=113 where id=$1`, [ev]);
  await as('commissioner', `insert into event_sessions (event_id, session_number, session_date, start_time) values ($1, 1, $2, '18:00')`, [ev, day1]);
  if (day2) await as('commissioner', `insert into event_sessions (event_id, session_number, session_date, start_time) values ($1, 2, $2, '18:00')`, [ev, day2]);
  const s = await as('commissioner', `select id, session_number from event_sessions where event_id=$1 order by session_number`, [ev]);
  return { ev, s1: s.rows[0]?.id as string, s2: s.rows[1]?.id as string };
}
const assign = (ev: string, session: string, player: number) =>
  as('commissioner', `insert into session_assignments (event_id, session_id, player_id) values ($1,$2,$3)`, [ev, session, demoIds.pid(player)]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const dir = join(ROOT, 'supabase/migrations');
  // Like a new Supabase project: the web roles get nothing unless the migrations grant it.
  await db.exec(`alter default privileges in schema public revoke execute on functions from public;`);
  for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));
  await db.exec(`
    insert into auth.users values ('${COMMISH}', 'commish@example.com'), ('${STRANGER}', 'x@example.com');
    insert into public.commissioners values ('${COMMISH}');
  `);
  await db.exec(seedSql());
}, 60_000);

describe('seed', () => {
  it('has exactly five events and an eight-player event across consecutive days', async () => {
    const ev = await as('public', `select count(*)::int n from events where season_year = 2026`);
    expect(ev.rows[0].n).toBe(5);
    const s = await as('public', `
      select s.session_number, s.session_date::text d, count(a.id)::int n
      from event_sessions s left join session_assignments a on a.session_id = s.id
      where s.event_id = $1 group by 1, 2 order by 1`, [demoIds.eid(1)]);
    expect(s.rows).toEqual([{ session_number: 1, d: '2026-11-02', n: 4 }, { session_number: 2, d: '2026-11-03', n: 4 }]);
  });

  it('acceptance 1: Mon + Tue produce one result on the eight-player table, matching the app engine', async () => {
    const r = await as('public', `select player_id, position, points::float p, net from event_results where event_id = $1 order by position, player_id`, [demoIds.eid(1)]);
    expect(r.rows).toHaveLength(8);
    expect(r.rows.reduce((t, x) => t + (x.p as number), 0)).toBe(65); // 16+13+11+9+7+5+3+1
    const app = (await buildDemoSnapshot()).results.filter((x) => x.event_id === demoIds.eid(1));
    for (const row of r.rows) {
      const mine = app.find((x) => x.player_id === row.player_id)!;
      expect({ pos: row.position, p: row.p, net: row.net }).toEqual({ pos: mine.position, p: mine.points, net: mine.net });
    }
    // Handicaps match too.
    const a = await as('public', `select player_id, strokes from session_assignments where event_id = $1`, [demoIds.eid(1)]);
    const snap = await buildDemoSnapshot();
    for (const row of a.rows) {
      expect(row.strokes).toBe(snap.assignments.find((x) => x.event_id === demoIds.eid(1) && x.player_id === row.player_id)!.strokes);
    }
  });
});

describe('privacy (acceptance 4)', () => {
  it('hides Day 1 scores from the public while Day 2 is pending, but the commissioner still has them', async () => {
    const pub = await as('public', `select count(*)::int n from round_scores r join session_assignments a on a.id = r.assignment_id where a.event_id = $1`, [demoIds.eid(2)]);
    expect(pub.rows[0].n).toBe(0);
    const other = await as('stranger', `select count(*)::int n from round_scores r join session_assignments a on a.id = r.assignment_id where a.event_id = $1`, [demoIds.eid(2)]);
    expect(other.rows[0].n).toBe(0);
    const mine = await as('commissioner', `select count(*)::int n from round_scores r join session_assignments a on a.id = r.assignment_id where a.event_id = $1 and r.status = 'completed'`, [demoIds.eid(2)]);
    expect(mine.rows[0].n).toBe(4);
    const sessions = await as('public', `select session_number, status, session_date::text d from event_sessions where event_id = $1 order by 1`, [demoIds.eid(2)]);
    expect(sessions.rows.map((x) => x.status)).toEqual(['resolved', 'scheduled']);
  });

  it('shows published scores to everyone', async () => {
    const pub = await as('public', `select count(*)::int n from round_scores r join session_assignments a on a.id = r.assignment_id where a.event_id = $1`, [demoIds.eid(1)]);
    expect(pub.rows[0].n).toBe(8);
  });

  it('blocks non-commissioners from writing anything', async () => {
    await as('stranger', `update events set name = 'hacked' where id = $1`, [demoIds.eid(3)]);
    const r = await as('public', `select name from events where id = $1`, [demoIds.eid(3)]);
    expect(r.rows[0].name).toBe('Holiday Scramble');
    expect(await fails(as('stranger', `select publish_event($1)`, [demoIds.eid(2)]))).toMatch(/Only the commissioner/);
    expect(await fails(as('public', `select app_private.publish_event_core($1)`, [demoIds.eid(2)]))).toMatch(/permission denied/);
  });
});

describe('commissioner login', () => {
  it('lets only the account listed in commissioners act as commissioner', async () => {
    expect((await as('commissioner', `select is_commissioner() c`)).rows[0].c).toBe(true);
    expect((await as('stranger', `select is_commissioner() c`)).rows[0].c).toBe(false);
    expect((await as('public', `select is_commissioner() c`)).rows[0].c).toBe(false);
    expect(await fails(as('stranger', `insert into commissioners values ('${STRANGER}')`))).toMatch(/row-level security|permission denied/);
  });
});

describe('scheduling rules', () => {
  it('requires Day 2 to be the day after Day 1', async () => {
    const ev = demoIds.eid(5);
    await as('commissioner', `insert into event_sessions (event_id, session_number, session_date, start_time) values ($1, 1, '2027-01-11', '18:00')`, [ev]);
    expect(await fails(as('commissioner', `insert into event_sessions (event_id, session_number, session_date, start_time) values ($1, 2, '2027-01-13', '18:00')`, [ev]))).toMatch(/day after Day 1 \(2027-01-12/);
    await as('commissioner', `insert into event_sessions (event_id, session_number, session_date, start_time) values ($1, 2, '2027-01-12', '18:00')`, [ev]);
    expect(await fails(as('commissioner', `update event_sessions set session_date = '2027-01-04' where event_id = $1 and session_number = 1`, [ev]))).toMatch(/Day 1 must be 2027-01-11/);
    await as('commissioner', `delete from event_sessions where event_id = $1 and session_number = 2`, [ev]);
    await as('commissioner', `delete from event_sessions where event_id = $1 and session_number = 1`, [ev]);
  });

  it('acceptance 2: no fifth player in a session, and no player in both sessions', async () => {
    const { ev, s1, s2 } = await setupEvent4('2027-02-01', '2027-02-02');
    for (const p of [1, 2, 3, 4]) await assign(ev, s1, p);
    expect(await fails(assign(ev, s1, 5))).toMatch(/Day 1 already has 4 players/);
    expect(await fails(assign(ev, s2, 1))).toMatch(/already assigned to Day 1/);
    for (const p of [5, 6, 7, 8]) await assign(ev, s2, p);
    expect(await fails(as('commissioner', `update session_assignments set session_id = $1 where event_id = $2 and player_id = $3`, [s1, ev, demoIds.pid(5)]))).toMatch(/Day 1 already has 4/);
  });

  it('locks setup, confirms handicaps, and then freezes course and groups', async () => {
    const ev = demoIds.eid(4);
    await as('commissioner', `select lock_event($1)`, [ev]);
    const a = await as('public', `select count(*)::int n from session_assignments where event_id = $1 and handicap_confirmed_at is not null and strokes is not null`, [ev]);
    expect(a.rows[0].n).toBe(8);
    expect(await fails(as('commissioner', `update events set tees = 'Black' where id = $1`, [ev]))).toMatch(/setup is locked/);
    expect(await fails(as('commissioner', `delete from session_assignments where event_id = $1 and player_id = $2`, [ev, demoIds.pid(1)]))).toMatch(/Unlock the event/);
    // Scores can't be marked completed without 9 holes, and resolving needs every player resolved.
    expect(await fails(as('commissioner', `update round_scores r set hole_scores = array[4,4,4,null,null,null,null,null,null]::smallint[], status='completed' from session_assignments a where a.id=r.assignment_id and a.event_id=$1 and a.player_id=$2`, [ev, demoIds.pid(1)]))).toMatch(/all 9 holes/);
    expect(await fails(as('commissioner', `select resolve_session(id) from event_sessions where event_id=$1 and session_number=1`, [ev]))).toMatch(/Still waiting on/);
  });

  it('acceptance 3 in the database: a cross-day tie for 1st is 14.5 each, next is 3rd', async () => {
    const ev = demoIds.eid(4);
    // strokes are 0 on this flat test rating? No: course 36/113/36 gives index*0.4. Use gross to set nets.
    const strokes = await as('commissioner', `select player_id, strokes from session_assignments where event_id = $1`, [ev]);
    const st = Object.fromEntries(strokes.rows.map((r) => [r.player_id, r.strokes as number]));
    const targetNet: Record<number, number> = { 1: 33, 5: 33, 2: 35, 3: 36, 4: 37, 6: 38, 7: 39, 8: 40 };
    for (const [p, net] of Object.entries(targetNet)) {
      const gross = net + st[demoIds.pid(Number(p))];
      const h = Array(9).fill(Math.floor(gross / 9));
      for (let i = 0; i < gross % 9; i++) h[i]++;
      await as('commissioner', `update round_scores r set hole_scores = $1::smallint[], status='completed' from session_assignments a where a.id=r.assignment_id and a.event_id=$2 and a.player_id=$3`, [h, ev, demoIds.pid(Number(p))]);
    }
    await as('commissioner', `select resolve_session(id) from event_sessions where event_id=$1 and session_number=1`, [ev]);
    // Day 2 pending: still private
    const pub = await as('public', `select count(*)::int n from event_results where event_id = $1`, [ev]);
    expect(pub.rows[0].n).toBe(0);
    expect(await fails(as('commissioner', `select publish_event($1)`, [ev]))).toMatch(/Complete every scheduled day/);
    await as('commissioner', `select resolve_session(id) from event_sessions where event_id=$1 and session_number=2`, [ev]);
    await as('commissioner', `select publish_event($1)`, [ev]);
    const r = await as('public', `select player_id, session_number, position, tied, points::float p from event_results where event_id=$1 order by position, session_number`, [ev]);
    expect(r.rows.slice(0, 3)).toEqual([
      { player_id: demoIds.pid(1), session_number: 1, position: 1, tied: true, p: 14.5 },
      { player_id: demoIds.pid(5), session_number: 2, position: 1, tied: true, p: 14.5 },
      { player_id: demoIds.pid(2), session_number: 1, position: 3, tied: false, p: 11 },
    ]);
  });

  it('acceptance 5 in the database: a four-player single session awards 12, 9, 6, 3', async () => {
    // Event 5: single session, four players.
    const ev = demoIds.eid(5);
    await as('commissioner', `update events set course_name='Test Links', tees='White', par9=36, course_rating9=36, slope9=113 where id=$1`, [ev]);
    await as('commissioner', `insert into event_sessions (event_id, session_number, session_date, start_time) values ($1, 1, '2027-03-01', '18:00')`, [ev]);
    const s1 = (await as('commissioner', `select id from event_sessions where event_id=$1 and session_number=1`, [ev])).rows[0].id as string;
    for (const p of [1, 2, 3, 4]) await assign(ev, s1, p);
    await as('commissioner', `select lock_event($1)`, [ev]);
    const holes = [[4,4,4,4,4,4,4,4,4],[5,5,5,5,5,5,5,5,5],[6,6,6,6,6,6,6,6,6],[7,7,7,7,7,7,7,7,7]];
    for (let i = 0; i < 4; i++) {
      await as('commissioner', `update round_scores r set hole_scores=$1::smallint[], status='completed' from session_assignments a where a.id=r.assignment_id and a.event_id=$2 and a.player_id=$3`, [holes[i], ev, demoIds.pid(i + 1)]);
    }
    await as('commissioner', `select resolve_session($1)`, [s1]);
    await as('commissioner', `select publish_event($1)`, [ev]);
    const r = await as('public', `select points::float p from event_results where event_id=$1 order by position`, [ev]);
    expect(r.rows.map((x) => x.p)).toEqual([12, 9, 6, 3]);
  });

  it('refuses to publish a field size with no approved table', async () => {
    const ev = demoIds.eid(2);
    // Finish Day 2 with one no-show → 7 starters.
    const players = [1, 3, 4, 7];
    for (const p of players) {
      const status = p === 7 ? 'dna' : 'completed';
      const h = p === 7 ? [null, null, null, null, null, null, null, null, null] : [5, 5, 5, 5, 5, 5, 5, 5, 5];
      await as('commissioner', `update round_scores r set hole_scores=$1::smallint[], status=$2 from session_assignments a where a.id=r.assignment_id and a.event_id=$3 and a.player_id=$4`, [h, status, ev, demoIds.pid(p)]);
    }
    await as('commissioner', `select resolve_session(id) from event_sessions where event_id=$1 and session_number=2`, [ev]);
    expect(await fails(as('commissioner', `select publish_event($1)`, [ev]))).toMatch(/No approved points table for a 7-player field/);
  });
});


describe('scramble (database)', () => {
  const ev = demoIds.eid(3);
  const T = demoIds.tid;
  const entryOf = async (team: number) =>
    (await as('commissioner', `select id, strokes from event_entries where event_id = $1 and team_id = $2`, [ev, T(team)])).rows[0] as { id: string; strokes: number };
  const teamCard = async (team: number, holes: (number | null)[], status = 'completed') =>
    as('commissioner', `update entry_round_scores set hole_scores = $1::smallint[], status = $2 where entry_id = $3`, [holes, status, (await entryOf(team)).id]);

  it('keeps one team per player, at most four teams, and only the commissioner edits teams', async () => {
    expect(await fails(as('commissioner', `insert into teams (season_year, name, player_a, player_b) values (2026, 'Extra', $1, $2)`, [demoIds.pid(1), demoIds.pid(2)]))).toMatch(/at most 4/);
    expect(await fails(as('commissioner', `update teams set player_b = $1 where id = $2`, [demoIds.pid(2), T(1)]))).toMatch(/only one team per season/);
    expect(await fails(as('stranger', `insert into teams (season_year, name, player_a, player_b) values (2027, 'X', $1, $2)`, [demoIds.pid(1), demoIds.pid(2)]))).toMatch(/row-level security|permission denied/);
  });

  it('refuses to lock when teammates are split across days', async () => {
    const day = async (n: number) => (await as('commissioner', `select id from event_sessions where event_id=$1 and session_number=$2`, [ev, n])).rows[0].id as string;
    const [d1, d2] = [await day(1), await day(2)];
    await as('commissioner', `delete from session_assignments where event_id=$1 and player_id=$2`, [ev, demoIds.pid(8)]);
    await as('commissioner', `update session_assignments set session_id = $1 where event_id = $2 and player_id = $3`, [d1, ev, demoIds.pid(3)]);
    await as('commissioner', `insert into session_assignments (event_id, session_id, player_id) values ($1, $2, $3)`, [ev, d2, demoIds.pid(8)]);
    expect(await fails(as('commissioner', `select lock_event($1)`, [ev]))).toMatch(/Both teammates must be assigned to the same day/);
    await as('commissioner', `delete from session_assignments where event_id=$1 and player_id in ($2, $3)`, [ev, demoIds.pid(8), demoIds.pid(3)]);
    await as('commissioner', `insert into session_assignments (event_id, session_id, player_id) values ($1, $2, $3), ($1, $4, $5)`, [ev, d1, demoIds.pid(8), d2, demoIds.pid(3)]);
  });

  it('locks with team strokes matching the app, keeps cards private, and averages the places for a cross-day tie', async () => {
    await as('commissioner', `select lock_event($1)`, [ev]);
    const teams = await as('public', `
      select e.id, e.team_id, e.strokes, array_agg(m.course_handicap::float order by m.course_handicap) chs
      from event_entries e join entry_members m on m.entry_id = e.id where e.event_id = $1 group by e.id`, [ev]);
    expect(teams.rows).toHaveLength(4);
    for (const t of teams.rows) expect(t.strokes).toBe(teamCardStrokes({ format: 'scramble', team_size: 2 }, t.chs as number[]));
    expect(await fails(as('commissioner', `update events set format = 'individual' where id = $1`, [ev]))).toMatch(/setup is locked/);
    expect(await fails(teamCard(1, [3, 3, 3, null, null, null, null, null, null]))).toMatch(/all 9 holes/);
    const card = async (net: number, team: number) => {
      const g = net + (await entryOf(team)).strokes;
      return Array.from({ length: 9 }, (_, i) => Math.floor(g / 9) + (i < g % 9 ? 1 : 0));
    };
    await teamCard(1, await card(30, 1));
    await teamCard(2, await card(32, 2));
    await as('commissioner', `select resolve_session(id) from event_sessions where event_id=$1 and session_number=1`, [ev]);
    expect((await as('public', `select count(*)::int n from entry_round_scores r join event_entries e on e.id = r.entry_id where e.event_id = $1`, [ev])).rows[0].n).toBe(0);
    await teamCard(3, await card(30, 3));
    await teamCard(4, await card(33, 4));
    await as('commissioner', `select resolve_session(id) from event_sessions where event_id=$1 and session_number=2`, [ev]);
    await as('commissioner', `select publish_event($1)`, [ev]);
    const r = await as('public', `select team_id, position, points::float p from event_results where event_id = $1`, [ev]);
    const byTeam = (n: number) => r.rows.filter((x) => x.team_id === T(n)).map((x) => [x.position, x.p]);
    expect(byTeam(1)).toEqual([[1, 12.25], [1, 12.25]]); // places 1–4
    expect(byTeam(3)).toEqual([[1, 12.25], [1, 12.25]]);
    expect(byTeam(2)).toEqual([[3, 6], [3, 6]]); // places 5–6
    expect(byTeam(4)).toEqual([[4, 2], [4, 2]]); // places 7–8
    expect((await as('public', `select count(*)::int n from entry_round_scores r join event_entries e on e.id = r.entry_id where e.event_id = $1`, [ev])).rows[0].n).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Every format: the database and the app engine must produce the same results
// ---------------------------------------------------------------------------
const num = (x: unknown) => (x == null ? null : Number(x));

async function dbSnapshot(): Promise<Snapshot> {
  const q = async (sql: string) => (await as('commissioner', sql)).rows as Record<string, unknown>[];
  const st = (await q(`select * from league_settings`))[0];
  return {
    settings: {
      league_name: st.league_name as string, season_year: st.season_year as number, field_size_basis: st.field_size_basis as 'starters',
      time_zone: 'America/Chicago', match_win_points: num(st.match_win_points), match_halve_points: num(st.match_halve_points),
    },
    players: (await q(`select * from players`)).map((p) => ({ ...p, handicap_index: num(p.handicap_index) })) as never,
    events: (await q(`select * from events`)).map((e) => ({ ...e, course_rating9: num(e.course_rating9) })) as never,
    sessions: (await q(`select *, session_date::text as session_date, to_char(start_time, 'HH24:MI') as start_time from event_sessions`)) as never,
    assignments: (await q(`select * from session_assignments`)).map((a) => ({ ...a, index_used: num(a.index_used), course_handicap: num(a.course_handicap) })) as never,
    scores: (await q(`select * from round_scores`)) as never,
    results: [],
    teams: (await q(`select * from teams`)) as never,
    entries: (await q(`select * from event_entries`)) as never,
    entryMembers: (await q(`select * from entry_members`)).map((m) => ({ ...m, course_handicap: Number(m.course_handicap) })) as never,
    entryScores: (await q(`select * from entry_round_scores`)) as never,
  };
}

/** Deterministic, varied hole scores (3–6). */
const holesFor = (p: number) => Array.from({ length: 9 }, (_, h) => 3 + ((p * 7 + h * 3 + p * h) % 4));
const DAY1 = [1, 8, 2, 7]; // Jim & Tony, Austin & Bryan
const DAY2 = [3, 6, 4, 5]; // Mike & Marshall, Viet & Donnie B

interface Scenario {
  name: string;
  format: EventFormat;
  team_size?: number;
  counting?: number;
  match_type?: string;
  slots?: Record<number, 1 | 2>;
  dna?: number[];
  dnf?: number[];
}

let seasonNo = 2040;
async function runScenario(sc: Scenario) {
  const season = seasonNo++;
  await db.exec(`
    select set_config('jimulator.workflow', 'off', false);
    select app_private.create_season_core(${season});
    insert into teams (season_year, name, player_a, player_b)
      select ${season}, name, player_a, player_b from teams where season_year = 2026;
  `);
  const ev = (await db.query<{ id: string }>(`select id from events where season_year = ${season} and event_number = 1`)).rows[0].id;
  await as('commissioner', `update events set course_name='Bandon', tees='Green', par9=36, course_rating9=35.9, slope9=128,
    format=$2, team_size=$3, counting_scores=$4, match_type=$5, hole_si=array[7,3,15,1,11,5,17,9,13]::smallint[] where id=$1`,
    [ev, sc.format, sc.team_size ?? 2, sc.counting ?? 1, sc.match_type ?? 'singles']);
  await as('commissioner', `insert into event_sessions (event_id, session_number, session_date, start_time) values ($1, 1, '2027-02-01', '18:00')`, [ev]);
  await as('commissioner', `insert into event_sessions (event_id, session_number, session_date, start_time) values ($1, 2, '2027-02-02', '18:00')`, [ev]);
  const day = async (n: number) => (await as('commissioner', `select id from event_sessions where event_id=$1 and session_number=$2`, [ev, n])).rows[0].id as string;
  const [d1, d2] = [await day(1), await day(2)];
  for (const [sid, ps] of [[d1, DAY1], [d2, DAY2]] as const) {
    for (const p of ps) {
      await as('commissioner', `insert into session_assignments (event_id, session_id, player_id, match_slot) values ($1, $2, $3, $4)`, [ev, sid, demoIds.pid(p), sc.slots?.[p] ?? null]);
    }
  }
  await as('commissioner', `select lock_event($1)`, [ev]);

  // Lock: the database's entries match what the app engine plans.
  let snap = await dbSnapshot();
  const event = snap.events.find((e) => e.id === ev)!;
  const planned = planEntries(event, snap, (pid) => snap.assignments.find((a) => a.event_id === ev && a.player_id === pid)!.course_handicap);
  const dbEntries = snap.entries.filter((e) => e.event_id === ev);
  expect(dbEntries).toHaveLength(planned.length);
  for (const pe of planned) {
    const members = pe.members.map((m) => m.player_id).sort();
    const match = dbEntries.find((e) => JSON.stringify(snap.entryMembers.filter((m) => m.entry_id === e.id).map((m) => m.player_id).sort()) === JSON.stringify(members))!;
    expect(match.strokes).toBe(pe.strokes);
    for (const m of pe.members) {
      expect(snap.entryMembers.find((x) => x.entry_id === match.id && x.player_id === m.player_id)!.playing_handicap).toBe(m.playing_handicap);
    }
  }

  // Scores
  const teamCard = sc.format === 'scramble' || sc.format === 'alt_shot';
  if (teamCard) {
    for (const [i, e] of dbEntries.entries()) {
      await as('commissioner', `update entry_round_scores set hole_scores=$1::smallint[], status='completed' where entry_id=$2`, [holesFor(i + 1), e.id]);
    }
  } else {
    for (const p of [...DAY1, ...DAY2]) {
      const [holes, status] = sc.dna?.includes(p) ? [Array(9).fill(null), 'dna'] : sc.dnf?.includes(p) ? [[...holesFor(p).slice(0, 4), null, null, null, null, null], 'dnf'] : [holesFor(p), 'completed'];
      await as('commissioner', `update round_scores r set hole_scores=$1::smallint[], status=$2 from session_assignments a where a.id=r.assignment_id and a.event_id=$3 and a.player_id=$4`, [holes, status, ev, demoIds.pid(p)]);
    }
  }
  for (const sid of [d1, d2]) await as('commissioner', `select resolve_session($1)`, [sid]);

  snap = await dbSnapshot();
  const expected = computeOutcome(snap, ev);
  expect(expected.blockers).toEqual([]);
  await as('commissioner', `select publish_event($1)`, [ev]);
  const got = (await as('public', `select player_id, status, position, tied, gross, strokes, net, points::float points, detail from event_results where event_id=$1`, [ev])).rows;
  expect(got).toHaveLength(8);
  for (const want of expected.results) {
    const row = got.find((g) => g.player_id === want.player_id)!;
    expect({ who: want.player_id, ...row }).toEqual({
      who: want.player_id, player_id: want.player_id, status: want.status, position: want.position, tied: want.tied,
      gross: want.gross, strokes: want.strokes, net: want.net, points: want.points, detail: want.detail,
    });
  }
  return got;
}

describe('every format: database matches the app engine', () => {
  beforeAll(async () => {
    await db.exec(`update league_settings set match_win_points = 12, match_halve_points = 6`);
  });
  const scenarios: Scenario[] = [
    { name: '2-person scramble', format: 'scramble', team_size: 2 },
    { name: '4-person scramble', format: 'scramble', team_size: 4 },
    { name: 'alternate shot', format: 'alt_shot' },
    { name: '2-person best ball, one partner DNF', format: 'best_ball', team_size: 2, counting: 1, dnf: [8] },
    { name: '2-person best ball, both count', format: 'best_ball', team_size: 2, counting: 2 },
    { name: '4-person shamble, best 2', format: 'shamble', team_size: 4, counting: 2 },
    { name: '4-person best ball, best 1, a no-show', format: 'best_ball', team_size: 4, counting: 1, dna: [6] },
    { name: 'match play singles with a forfeit', format: 'match_play', match_type: 'singles', slots: { 1: 1, 8: 1, 2: 2, 7: 2, 3: 1, 6: 1, 4: 2, 5: 2 }, dna: [4] },
    { name: 'match play 2 vs 2', format: 'match_play', match_type: 'fourball' },
  ];
  for (const sc of scenarios) {
    it(sc.name, async () => {
      const got = await runScenario(sc);
      if (sc.format !== 'match_play') expect(got.reduce((t, r) => t + (r.points as number), 0)).toBeCloseTo(65, 1); // every place awarded once
    });
  }
});
