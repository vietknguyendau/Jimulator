// Runs the real migrations + seed in PGlite (Postgres in WASM) with a stand-in for
// Supabase's auth schema, then exercises the rules as the commissioner and the public.
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedSql } from '../scripts/generate-seed';
import { buildDemoSnapshot, demoIds } from '../src/data/demoSeed';

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
  await as('commissioner', `update events set course_name='Test Links', tees='White', par9=36, course_rating9=36, slope9=113 where id=$1`, [ev]);
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
  for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));
  await db.exec(`
    grant usage on schema public to anon, authenticated;
    grant select, insert, update, delete on all tables in schema public to anon, authenticated;
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
    expect(r.rows[0].name).toBe('Holiday Classic');
    expect(await fails(as('stranger', `select publish_event($1)`, [demoIds.eid(2)]))).toMatch(/Only the commissioner/);
    expect(await fails(as('public', `select app_private.publish_event_core($1)`, [demoIds.eid(2)]))).toMatch(/permission denied/);
  });
});

describe('commissioner login', () => {
  it('lets only the account listed in commissioners act as commissioner', async () => {
    expect((await as('commissioner', `select is_commissioner() c`)).rows[0].c).toBe(true);
    expect((await as('stranger', `select is_commissioner() c`)).rows[0].c).toBe(false);
    expect((await as('public', `select is_commissioner() c`)).rows[0].c).toBe(false);
    expect(await fails(as('stranger', `insert into commissioners values ('${STRANGER}')`))).toMatch(/row-level security/);
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
    // Reuse event 3: single session, four players.
    const ev = demoIds.eid(3);
    await as('commissioner', `delete from event_sessions where event_id=$1 and session_number=2`, [ev]);
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
