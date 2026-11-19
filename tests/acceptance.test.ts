// The five acceptance checks, driven through the same data layer the app uses
// (the local store mirrors the Supabase rules; tests/db.test.ts checks the database itself).
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoSnapshot, demoIds } from '../src/data/demoSeed';
import { DEMO_COMMISSIONER, LocalRepo, memoryKV, type KV } from '../src/data/localRepo';
import { eventPhase } from '../src/lib/eventPhase';
import { seasonStandings } from '../src/lib/standings';
import type { Snapshot } from '../src/lib/types';

const flat = (gross: number) => {
  const h = Array(9).fill(Math.floor(gross / 9));
  for (let i = 0; i < gross % 9; i++) h[i]++;
  return h as number[];
};

let kv: KV;
let repo: LocalRepo;
let seed: Snapshot;
const EV = demoIds.eid(5); // empty draft event in the demo season

async function signIn() {
  await repo.signIn(DEMO_COMMISSIONER.email, DEMO_COMMISSIONER.password);
}

/** Flat 9-hole rating so strokes = round(index × 0.4); makes target nets easy. */
async function setupEvent(day1: string, day2: string | null, groups: [number[], number[]]) {
  await repo.updateEvent(EV, { course_name: 'Test Links', tees: 'White', par9: 36, course_rating9: 36, slope9: 113 });
  await repo.saveSession(EV, 1, day1, '18:00');
  if (day2) await repo.saveSession(EV, 2, day2, '18:00');
  const s = await repo.load();
  const ss = s.sessions.filter((x) => x.event_id === EV).sort((a, b) => a.session_number - b.session_number);
  for (const p of groups[0]) await repo.assign(EV, ss[0].id, demoIds.pid(p));
  for (const p of groups[1]) await repo.assign(EV, ss[1].id, demoIds.pid(p));
  return ss;
}

async function scoreNets(nets: Record<number, number>) {
  const s = await repo.load();
  for (const [p, net] of Object.entries(nets)) {
    const a = s.assignments.find((x) => x.event_id === EV && x.player_id === demoIds.pid(Number(p)))!;
    await repo.saveScore(a.id, flat(net + a.strokes!), 'completed');
  }
}

const resultsFor = async (id: string) => {
  const s = await repo.load();
  return s.results.filter((r) => r.event_id === id).sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
};

beforeEach(async () => {
  seed ??= await buildDemoSnapshot();
  kv = memoryKV();
  repo = new LocalRepo(kv, () => JSON.parse(JSON.stringify(seed)));
  await signIn();
});

describe('acceptance checks', () => {
  it('1. Monday 4 + Tuesday 4 produce one event result on the eight-player table', async () => {
    const [mon, tue] = await setupEvent('2027-01-04', '2027-01-05', [[1, 2, 3, 4], [5, 6, 7, 8]]);
    await repo.lockEvent(EV);
    await scoreNets({ 1: 33, 2: 34, 3: 35, 4: 36, 5: 37, 6: 38, 7: 39, 8: 40 });
    await repo.resolveSession(mon.id);
    await repo.resolveSession(tue.id);
    await repo.publishEvent(EV);
    const r = await resultsFor(EV);
    expect(r).toHaveLength(8);
    expect(r.map((x) => x.points)).toEqual([16, 13, 11, 9, 7, 5, 3, 1]);
    expect(new Set(r.map((x) => x.session_number))).toEqual(new Set([1, 2]));
    // Also true of the seeded demo event (Mon Nov 2 + Tue Nov 3).
    const demo = await resultsFor(demoIds.eid(1));
    expect(demo.reduce((t, x) => t + x.points, 0)).toBe(65);
  });

  it('2. blocks a fifth player in either session, and a player in both sessions', async () => {
    const [mon, tue] = await setupEvent('2027-01-04', '2027-01-05', [[1, 2, 3, 4], [5, 6, 7]]);
    await expect(repo.assign(EV, mon.id, demoIds.pid(8))).rejects.toThrow(/Day 1 already has 4 players/);
    await expect(repo.assign(EV, tue.id, demoIds.pid(1))).rejects.toThrow(/already assigned to Day 1/);
    await repo.assign(EV, tue.id, demoIds.pid(8));
    const s = await repo.load();
    const extra = s.assignments.find((a) => a.event_id === EV && a.player_id === demoIds.pid(8))!;
    await expect(repo.moveAssignment(extra.id, mon.id)).rejects.toThrow(/Day 1 already has 4/);
    // Second session must be the next calendar day.
    await expect(repo.saveSession(EV, 2, '2027-01-06', '18:00')).rejects.toThrow(/day after Day 1/);
  });

  it('3. a Day 1 and a Day 2 player tie for first: 14.5 each, next player is third', async () => {
    const [mon, tue] = await setupEvent('2027-01-04', '2027-01-05', [[1, 2, 3, 4], [5, 6, 7, 8]]);
    await repo.lockEvent(EV);
    await scoreNets({ 1: 33, 5: 33, 2: 35, 3: 36, 4: 37, 6: 38, 7: 39, 8: 40 });
    await repo.resolveSession(mon.id);
    await repo.resolveSession(tue.id);
    await repo.publishEvent(EV);
    const r = await resultsFor(EV);
    const one = r.find((x) => x.player_id === demoIds.pid(1))!;
    const five = r.find((x) => x.player_id === demoIds.pid(5))!;
    const next = r.find((x) => x.player_id === demoIds.pid(2))!;
    expect([one.session_number, five.session_number]).toEqual([1, 2]);
    expect([one.points, five.points]).toEqual([14.5, 14.5]);
    expect([one.position, five.position, next.position]).toEqual([1, 1, 3]);
    expect(next.points).toBe(11);
  });

  it('4. Day 1 scores survive sign-out; the public sees "Day 2 pending" and no scores until published', async () => {
    const [mon, tue] = await setupEvent('2027-01-04', '2027-01-05', [[1, 2, 3, 4], [5, 6, 7, 8]]);
    await repo.lockEvent(EV);
    await scoreNets({ 1: 33, 2: 34, 3: 35, 4: 36 });
    await repo.resolveSession(mon.id);
    await repo.signOut();

    // Public view, and a brand-new app instance reading the same storage (like reopening the browser).
    const reopened = new LocalRepo(kv, () => seed);
    const pub = await reopened.load();
    const ev = pub.events.find((e) => e.id === EV)!;
    expect(eventPhase(ev, pub.sessions).label).toBe('Day 2 pending');
    const mine = new Set(pub.assignments.filter((a) => a.event_id === EV).map((a) => a.id));
    expect(pub.scores.filter((s) => mine.has(s.assignment_id))).toHaveLength(0);
    expect(pub.results.filter((r) => r.event_id === EV)).toHaveLength(0);
    // Both session dates are public.
    expect(pub.sessions.filter((s) => s.event_id === EV).map((s) => s.session_date)).toEqual(['2027-01-04', '2027-01-05']);
    await expect(reopened.saveScore([...mine][0], flat(40), 'completed')).rejects.toThrow(/Only the commissioner/);

    // Commissioner signs back in on Day 2: Day 1 scores are there, and entry resumes.
    await expect(reopened.signIn(DEMO_COMMISSIONER.email, 'nope')).rejects.toThrow(/Wrong email or password/);
    await reopened.signIn(DEMO_COMMISSIONER.email, DEMO_COMMISSIONER.password);
    const back = await reopened.load();
    const day1 = back.scores.filter((s) => mine.has(s.assignment_id) && s.status === 'completed');
    expect(day1).toHaveLength(4);
    repo = reopened;
    await scoreNets({ 5: 37, 6: 38, 7: 39, 8: 40 });
    await repo.resolveSession(tue.id);
    await repo.publishEvent(EV);
    await repo.signOut();
    const after = await repo.load();
    expect(eventPhase(after.events.find((e) => e.id === EV)!, after.sessions).label).toBe('Official results');
    expect(after.scores.filter((s) => mine.has(s.assignment_id))).toHaveLength(8);
  });

  it('5. a four-player single-day event still awards 12, 9, 6, 3', async () => {
    const [day] = await setupEvent('2027-01-04', null, [[1, 2, 3, 4], []]);
    await repo.lockEvent(EV);
    await scoreNets({ 1: 33, 2: 34, 3: 35, 4: 36 });
    await repo.resolveSession(day.id);
    await repo.publishEvent(EV);
    expect((await resultsFor(EV)).map((x) => x.points)).toEqual([12, 9, 6, 3]);
  });
});

describe('event workflow rules', () => {
  it('locks setup and handicaps before scoring, and keeps them fixed', async () => {
    const [mon] = await setupEvent('2027-01-04', '2027-01-05', [[1, 2, 3, 4], [5, 6, 7, 8]]);
    const s = await repo.load();
    const a = s.assignments.find((x) => x.event_id === EV)!;
    await expect(repo.saveScore(a.id, flat(40), 'completed')).rejects.toThrow(/Lock the event/);
    await repo.lockEvent(EV);
    const locked = await repo.load();
    expect(locked.assignments.filter((x) => x.event_id === EV).every((x) => x.handicap_confirmed_at && x.strokes != null)).toBe(true);
    await expect(repo.updateEvent(EV, { tees: 'Black' })).rejects.toThrow(/setup is locked/);
    await expect(repo.assign(EV, mon.id, demoIds.pid(1))).rejects.toThrow(/Unlock/);
    // Unlock is allowed only before any score is entered.
    await repo.unlockEvent(EV);
    await repo.lockEvent(EV);
    await repo.saveScore(a.id, [4, 4, 4, null, null, null, null, null, null], 'pending');
    await expect(repo.unlockEvent(EV)).rejects.toThrow(/stay locked/);
  });

  it('requires one session for four players and two for eight', async () => {
    await setupEvent('2027-01-04', '2027-01-05', [[1, 2], [3, 4]]);
    await expect(repo.lockEvent(EV)).rejects.toThrow(/one session/);
  });

  it('finalizes only when every session is resolved and every player is accounted for', async () => {
    const [mon, tue] = await setupEvent('2027-01-04', '2027-01-05', [[1, 2, 3, 4], [5, 6, 7, 8]]);
    await repo.lockEvent(EV);
    await scoreNets({ 1: 33, 2: 34, 3: 35, 4: 36, 5: 37, 6: 38, 7: 39 });
    await expect(repo.resolveSession(tue.id)).rejects.toThrow(/Still waiting on: Tony/);
    await repo.resolveSession(mon.id);
    await expect(repo.publishEvent(EV)).rejects.toThrow(/Complete every scheduled day/);
    const s = await repo.load();
    const tony = s.assignments.find((x) => x.event_id === EV && x.player_id === demoIds.pid(8))!;
    await repo.saveScore(tony.id, [5, 5, 5, 5, null, null, null, null, null], 'dnf');
    await repo.resolveSession(tue.id);
    await repo.publishEvent(EV); // 8 starters (7 finishers + 1 DNF) → 8-player table
    const r = await resultsFor(EV);
    expect(r.find((x) => x.player_id === demoIds.pid(8))).toMatchObject({ status: 'dnf', points: 0, position: null });
    expect(r.filter((x) => x.status === 'completed').map((x) => x.points)).toEqual([16, 13, 11, 9, 7, 5, 3]);
  });

  it('holds field sizes other than 4 or 8 (unresolved policy)', async () => {
    await repo.updateSettings({ field_size_basis: 'finishers' });
    const [mon, tue] = await setupEvent('2027-01-04', '2027-01-05', [[1, 2, 3, 4], [5, 6, 7, 8]]);
    await repo.lockEvent(EV);
    await scoreNets({ 1: 33, 2: 34, 3: 35, 4: 36, 5: 37, 6: 38, 7: 39 });
    const s = await repo.load();
    const tony = s.assignments.find((x) => x.event_id === EV && x.player_id === demoIds.pid(8))!;
    await repo.saveScore(tony.id, Array(9).fill(null), 'dna');
    await repo.resolveSession(mon.id);
    await repo.resolveSession(tue.id);
    await expect(repo.publishEvent(EV)).rejects.toThrow(/No approved points table for a 7-player field/);
  });

  it('builds season standings from published events only', async () => {
    const s = await repo.load();
    const standings = seasonStandings(s.players, s.events, s.results);
    expect(standings.reduce((t, r) => t + r.points, 0)).toBe(65); // only Event 1 is official in the demo
  });
});
