// Every event format, through the same data layer the app uses.
// Expected numbers are worked out by hand on a flat test course (rating 36, slope 113, par 36),
// where each 9-hole course handicap is simply index ÷ 2:
//   Jim 7.35 · Tony 13.65 · Austin 7.85 · Bryan 8.1 · Mike 8.1 · Marshall 5.6 · Viet 9.45 · Donnie 5.7
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDemoSnapshot, demoIds } from '../src/data/demoSeed';
import { DEMO_COMMISSIONER, LocalRepo, memoryKV } from '../src/data/localRepo';
import type { EventSetupPatch } from '../src/data/repo';
import { holeStrokes, siRanks, teamCardStrokes } from '../src/lib/formats';
import { eventPhase } from '../src/lib/eventPhase';
import { seasonStandings, teamStandings } from '../src/lib/standings';
import type { Snapshot } from '../src/lib/types';

const P = { jim: 1, austin: 2, mike: 3, viet: 4, donnie: 5, marshall: 6, bryan: 7, tony: 8 };
const pid = (n: number) => demoIds.pid(n);
const T = demoIds.tid; // 1 Jim & Tony · 2 Austin & Bryan · 3 Mike & Marshall · 4 Viet & Donnie B
const EV = demoIds.eid(3); // draft: Day 1 = Jim, Tony, Austin, Bryan · Day 2 = Mike, Marshall, Viet, Donnie
const all = (n: number) => Array(9).fill(n) as number[];
const FLAT: EventSetupPatch = { course_name: 'Test Links', tees: 'White', par9: 36, course_rating9: 36, slope9: 113, hole_si: [1, 2, 3, 4, 5, 6, 7, 8, 9] };

let repo: LocalRepo;
let seed: Snapshot;
beforeEach(async () => {
  seed ??= await buildDemoSnapshot();
  repo = new LocalRepo(memoryKV(), () => JSON.parse(JSON.stringify(seed)));
  await repo.signIn(DEMO_COMMISSIONER.email, DEMO_COMMISSIONER.password);
});

const snap = () => repo.load();
const day = async (n: number) => (await snap()).sessions.find((s) => s.event_id === EV && s.session_number === n)!;
const assignmentOf = async (player: number) => (await snap()).assignments.find((a) => a.event_id === EV && a.player_id === pid(player))!;
async function setup(patch: EventSetupPatch) {
  await repo.updateEvent(EV, { ...FLAT, ...patch });
}
async function card(player: number, holes: (number | null)[], status: 'completed' | 'dnf' | 'dna' = 'completed') {
  await repo.saveScore((await assignmentOf(player)).id, holes, status);
}
const entryOf = async (pred: (members: string[], teamId: string | null) => boolean) => {
  const s = await snap();
  return s.entries.filter((e) => e.event_id === EV).find((e) => pred(s.entryMembers.filter((m) => m.entry_id === e.id).map((m) => m.player_id), e.team_id))!;
};
async function finish() {
  for (const n of [1, 2]) await repo.resolveSession((await day(n)).id);
  await repo.publishEvent(EV);
  return (await snap()).results.filter((r) => r.event_id === EV);
}
const pointsOf = (results: { player_id: string; points: number }[], player: number) => results.find((r) => r.player_id === pid(player))!.points;

describe('strokes hole by hole', () => {
  it('ranks the 9 holes by the course card stroke index', () => {
    expect(siRanks([7, 3, 15, 1, 11, 5, 17, 9, 13])).toEqual([4, 2, 8, 1, 6, 3, 9, 5, 7]);
    expect(siRanks([2, 1, 4, 3, 6, 5, 8, 7, 9])).toEqual([2, 1, 4, 3, 6, 5, 8, 7, 9]);
  });
  it('spreads strokes over the hardest holes, wrapping past 9', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => holeStrokes(3, r))).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => holeStrokes(12, r))).toEqual([2, 2, 2, 1, 1, 1, 1, 1, 1]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => holeStrokes(-2, r))).toEqual([0, 0, 0, 0, 0, 0, 0, -1, -1]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].reduce((t, r) => t + holeStrokes(14, r), 0)).toBe(14);
  });
  it('uses the official team-card allowances', () => {
    expect(teamCardStrokes({ format: 'scramble', team_size: 2 }, [7.35, 13.65])).toBe(5); // 2.5725 + 2.0475
    expect(teamCardStrokes({ format: 'scramble', team_size: 4 }, [13.65, 7.35, 8.1, 7.85])).toBe(6); // 5.9875
    expect(teamCardStrokes({ format: 'alt_shot', team_size: 2 }, [7.35, 13.65])).toBe(11); // 10.5
  });
});

describe('2-person scramble', () => {
  it('gives each teammate the average of the places the team fills', async () => {
    await setup({ format: 'scramble', team_size: 2 });
    await repo.lockEvent(EV);
    const s = await snap();
    const net = { [T(1)]: 30, [T(2)]: 32, [T(3)]: 31, [T(4)]: 33 };
    for (const e of s.entries.filter((x) => x.event_id === EV)) {
      const g = net[e.team_id!] + e.strokes!;
      await repo.saveEntryScore(e.id, [...all(Math.floor(g / 9))].map((h, i) => h + (i < g % 9 ? 1 : 0)), 'completed');
    }
    const r = await finish();
    expect(r).toHaveLength(8);
    // 8 players → 8-player table. 1st team covers places 1–2: (16+13)/2. Then 3–4, 5–6, 7–8.
    expect([pointsOf(r, P.jim), pointsOf(r, P.tony)]).toEqual([14.5, 14.5]);
    expect([pointsOf(r, P.mike), pointsOf(r, P.marshall)]).toEqual([10, 10]);
    expect([pointsOf(r, P.austin), pointsOf(r, P.bryan)]).toEqual([6, 6]);
    expect([pointsOf(r, P.viet), pointsOf(r, P.donnie)]).toEqual([2, 2]);
    const after = await snap();
    expect(teamStandings(after.teams, after.events, after.results)[0]).toMatchObject({ points: 14.5, firsts: 1 });
  });

  it('splits a cross-day tie across the combined places; the next team is third', async () => {
    await setup({ format: 'scramble', team_size: 2 });
    await repo.lockEvent(EV);
    const s = await snap();
    const net = { [T(1)]: 30, [T(3)]: 30, [T(2)]: 32, [T(4)]: 33 };
    for (const e of s.entries.filter((x) => x.event_id === EV)) {
      const g = net[e.team_id!] + e.strokes!;
      await repo.saveEntryScore(e.id, all(0).map((_, i) => Math.floor(g / 9) + (i < g % 9 ? 1 : 0)), 'completed');
    }
    const r = await finish();
    const jim = r.find((x) => x.player_id === pid(P.jim))!;
    const mike = r.find((x) => x.player_id === pid(P.mike))!;
    const austin = r.find((x) => x.player_id === pid(P.austin))!;
    expect([jim.session_number, mike.session_number]).toEqual([1, 2]);
    expect([jim.points, mike.points, jim.position, mike.position]).toEqual([12.25, 12.25, 1, 1]); // places 1–4
    expect([austin.position, austin.points]).toEqual([3, 6]); // places 5–6
  });

  it('keeps team cards private until results are published', async () => {
    await setup({ format: 'scramble', team_size: 2 });
    await repo.lockEvent(EV);
    const s = await snap();
    for (const e of s.entries.filter((x) => x.event_id === EV && x.session_id === s.sessions.find((y) => y.event_id === EV && y.session_number === 1)!.id)) {
      await repo.saveEntryScore(e.id, all(4), 'completed');
    }
    await repo.resolveSession((await day(1)).id);
    await repo.signOut();
    const pub = await snap();
    expect(eventPhase(pub.events.find((e) => e.id === EV)!, pub.sessions).label).toBe('Day 2 pending');
    const mine = new Set(pub.entries.filter((x) => x.event_id === EV).map((x) => x.id));
    expect(mine.size).toBe(4);
    expect(pub.entryScores.filter((r) => mine.has(r.entry_id))).toHaveLength(0);
  });

  it('a 4-player scramble (2 teams) now scores on the 4-player table', async () => {
    await setup({ format: 'scramble', team_size: 2 });
    const d2 = await day(2);
    for (const a of (await snap()).assignments.filter((x) => x.session_id === d2.id)) await repo.unassign(a.id);
    await repo.deleteSession(d2.id);
    await repo.lockEvent(EV);
    const s = await snap();
    const [a, b] = s.entries.filter((x) => x.event_id === EV);
    await repo.saveEntryScore(a.id, all(4), 'completed');
    await repo.saveEntryScore(b.id, all(5), 'completed');
    await repo.resolveSession((await day(1)).id);
    await repo.publishEvent(EV);
    const r = (await snap()).results.filter((x) => x.event_id === EV);
    expect(r.map((x) => x.points).sort((x, y) => y - x)).toEqual([10.5, 10.5, 4.5, 4.5]); // (12+9)/2, (6+3)/2
  });
});

describe('4-person scramble', () => {
  it('makes each day’s group a team, with 25/20/15/10% strokes', async () => {
    await setup({ format: 'scramble', team_size: 4 });
    await repo.lockEvent(EV);
    const s = await snap();
    const es = s.entries.filter((x) => x.event_id === EV);
    expect(es).toHaveLength(2);
    const d1 = es.find((e) => e.session_id === s.sessions.find((y) => y.event_id === EV && y.session_number === 1)!.id)!;
    const d2 = es.find((e) => e !== d1)!;
    expect([d1.strokes, d2.strokes]).toEqual([6, 5]); // 5.9875 → 6; 1.4+1.14+1.215+0.945 = 4.7 → 5
    await repo.saveEntryScore(d1.id, all(4), 'completed'); // 36 − 6 = 30
    await repo.saveEntryScore(d2.id, all(4), 'completed'); // 36 − 5 = 31
    const r = await finish();
    expect([P.jim, P.tony, P.austin, P.bryan].map((p) => pointsOf(r, p))).toEqual([12.25, 12.25, 12.25, 12.25]); // places 1–4
    expect([P.mike, P.marshall, P.viet, P.donnie].map((p) => pointsOf(r, p))).toEqual([4, 4, 4, 4]); // places 5–8
  });

  it('needs exactly four players in each session', async () => {
    await setup({ format: 'scramble', team_size: 4 });
    await repo.unassign((await assignmentOf(P.tony)).id);
    await expect(repo.lockEvent(EV)).rejects.toThrow(/Day 1 needs exactly 4 players/);
  });
});

describe('alternate shot', () => {
  it('uses 50% of the pair’s combined course handicaps', async () => {
    await setup({ format: 'alt_shot' });
    await repo.lockEvent(EV);
    expect((await entryOf((_, t) => t === T(1))).strokes).toBe(11); // (7.35 + 13.65) / 2 = 10.5 → 11
    expect((await entryOf((_, t) => t === T(4))).strokes).toBe(8); // (9.45 + 5.7) / 2 = 7.575 → 8
  });
});

describe('best ball', () => {
  it('2-person: 85% strokes on the hardest holes, better net counts', async () => {
    await setup({ format: 'best_ball', team_size: 2, counting_scores: 1 });
    await repo.lockEvent(EV);
    // Playing handicaps at 85%: Jim 6, Tony 12, Austin 7, Bryan 7, Mike 7, Marshall 5, Viet 8, Donnie 5.
    const s = await snap();
    const ph = (p: number) => s.entryMembers.find((m) => m.player_id === pid(p) && s.entries.some((e) => e.id === m.entry_id && e.event_id === EV))!.playing_handicap;
    expect([P.jim, P.tony, P.austin, P.bryan, P.mike, P.marshall, P.viet, P.donnie].map(ph)).toEqual([6, 12, 7, 7, 7, 5, 8, 5]);
    for (const p of Object.values(P)) await card(p, all(5));
    const r = await finish();
    // Everyone makes 5s. Jim & Tony: Tony's 12 strokes → 45 − 12 = 33. Viet & Donnie: 45 − 8 = 37.
    // Austin & Bryan and Mike & Marshall: 45 − 7 = 38, tied for the last four places.
    const jim = r.find((x) => x.player_id === pid(P.jim))!;
    expect([jim.net, jim.points]).toEqual([33, 14.5]);
    expect(r.find((x) => x.player_id === pid(P.viet))!).toMatchObject({ net: 37, points: 10, position: 2 });
    expect(r.find((x) => x.player_id === pid(P.austin))!).toMatchObject({ net: 38, points: 4, position: 3, tied: true });
    expect(r.find((x) => x.player_id === pid(P.mike))!).toMatchObject({ net: 38, points: 4, position: 3, tied: true });
  });

  it('a team can finish when one partner doesn’t', async () => {
    await setup({ format: 'best_ball', team_size: 2, counting_scores: 1 });
    await repo.lockEvent(EV);
    for (const p of Object.values(P)) if (p !== P.tony) await card(p, all(5));
    await card(P.tony, [5, 5, 5, null, null, null, null, null, null], 'dnf');
    const r = await finish();
    const jim = r.find((x) => x.player_id === pid(P.jim))!;
    // Holes 1–3: Tony's 5 − 2 = 3 is better; holes 4–9: Jim's own net (5 − 1 on holes 4–6, 5 on 7–9).
    expect(jim.status).toBe('completed');
    expect(jim.net).toBe(3 * 3 + 4 * 3 + 5 * 3);
  });

  it('needs the stroke index for every hole', async () => {
    await setup({ format: 'best_ball', team_size: 2, hole_si: [1, 2, 3, 4, 5, 6, 7, 8, null] as number[] });
    await expect(repo.lockEvent(EV)).rejects.toThrow(/stroke index/);
  });
});

describe('4-person shamble', () => {
  it('counts the best two nets on each hole', async () => {
    await setup({ format: 'shamble', team_size: 4, counting_scores: 2 });
    await repo.lockEvent(EV);
    for (const p of Object.values(P)) await card(p, all(5));
    const r = await finish();
    // Day 1 at 85%: Jim 6, Tony 12, Austin 7, Bryan 7. Best two nets: holes 1–3: 3+4 = 7; 4–7: 4+4 = 8; 8–9: 4+5 = 9 → 71.
    expect(r.find((x) => x.player_id === pid(P.jim))!.net).toBe(71);
  });
});

describe('match play', () => {
  async function pairSingles() {
    for (const [p, slot] of [[P.jim, 1], [P.tony, 1], [P.austin, 2], [P.bryan, 2], [P.mike, 1], [P.marshall, 1], [P.viet, 2], [P.donnie, 2]] as const) {
      await repo.setMatchSlot((await assignmentOf(p)).id, slot);
    }
  }

  it('is held until the commissioner sets the win and halve points', async () => {
    await setup({ format: 'match_play', match_type: 'singles' });
    await pairSingles();
    await repo.lockEvent(EV);
    for (const p of Object.values(P)) await card(p, all(5));
    for (const n of [1, 2]) await repo.resolveSession((await day(n)).id);
    await expect(repo.publishEvent(EV)).rejects.toThrow(/Set the match play points/);
  });

  it('singles: strokes off the low player; wins, halves and forfeits earn the set points', async () => {
    await repo.updateSettings({ match_win_points: 12, match_halve_points: 6 });
    await setup({ format: 'match_play', match_type: 'singles' });
    await pairSingles();
    await repo.lockEvent(EV);
    // Jim 7 vs Tony 14 → Tony gets 7 strokes. Austin 8 vs Bryan 8 → level. Mike 8 vs Marshall 6 → Mike gets 2.
    for (const p of [P.jim, P.tony, P.austin, P.bryan, P.mike]) await card(p, all(5));
    await card(P.marshall, all(4));
    await card(P.viet, Array(9).fill(null), 'dna');
    await card(P.donnie, all(5));
    const r = await finish();
    const d = (p: number) => r.find((x) => x.player_id === pid(p))!;
    expect([d(P.tony).points, d(P.tony).detail]).toEqual([12, 'Won 7 up vs Jim']);
    expect([d(P.jim).points, d(P.jim).detail]).toEqual([0, 'Lost 7 down to Tony']);
    expect([d(P.austin).points, d(P.bryan).points, d(P.austin).detail]).toEqual([6, 6, 'Halved with Bryan']);
    expect([d(P.marshall).points, d(P.marshall).detail]).toEqual([12, 'Won 7 up vs Mike']); // Mike's 2 strokes only halve 2 holes
    expect([d(P.donnie).points, d(P.donnie).detail]).toEqual([12, 'Won by forfeit vs Viet']);
    expect(d(P.viet).points).toBe(0);
    expect(d(P.tony).strokes).toBe(7);
  });

  it('singles: every player must be paired within their session', async () => {
    await setup({ format: 'match_play', match_type: 'singles' });
    await expect(repo.lockEvent(EV)).rejects.toThrow(/Match 1 or Match 2/);
  });

  it('2 vs 2: season teams, 90% off the low player, better net wins the hole', async () => {
    await repo.updateSettings({ match_win_points: 12, match_halve_points: 6 });
    await setup({ format: 'match_play', match_type: 'fourball' });
    await repo.lockEvent(EV);
    // Day 1 at 90%: Jim 7, Tony 12, Austin 7, Bryan 7 → off the low: Tony gets 5, the others 0.
    expect((await snap()).entryMembers.find((m) => m.player_id === pid(P.tony))!.playing_handicap).toBe(5);
    for (const p of Object.values(P)) await card(p, all(5));
    const r = await finish();
    expect(r.find((x) => x.player_id === pid(P.jim))!).toMatchObject({ points: 12, detail: 'Won 5 up vs Austin & Bryan' });
    expect(r.find((x) => x.player_id === pid(P.bryan))!).toMatchObject({ points: 0, detail: 'Lost 5 down to Jim & Tony' });
    const s = await snap();
    expect(seasonStandings(s.players, s.events, s.results).find((x) => x.player.id === pid(P.tony))!.points).toBeGreaterThanOrEqual(12);
  });
});

describe('team rules', () => {
  it('requires 2-person teammates on the same day', async () => {
    await setup({ format: 'best_ball', team_size: 2 });
    const d1 = await day(1);
    const d2 = await day(2);
    await repo.unassign((await assignmentOf(P.tony)).id);
    await repo.moveAssignment((await assignmentOf(P.mike)).id, d1.id);
    await repo.assign(EV, d2.id, pid(P.tony));
    await expect(repo.lockEvent(EV)).rejects.toThrow(/teammates must play the same day/);
  });

  it('assigns a 2-person team as a pair, only if the session has room', async () => {
    const d2 = await day(2);
    await repo.unassign((await assignmentOf(P.austin)).id);
    await repo.unassign((await assignmentOf(P.bryan)).id);
    await expect(repo.assignTeam(EV, d2.id, T(2))).rejects.toThrow(/already has 4 players/);
    await repo.assignTeam(EV, (await day(1)).id, T(2));
    const d1 = await day(1);
    expect((await snap()).assignments.filter((a) => a.session_id === d1.id)).toHaveLength(4);
  });

  it('keeps one team per player and at most four teams a season', async () => {
    await expect(repo.saveTeam({ season_year: 2026, name: 'Extra', player_a: pid(1), player_b: pid(2) })).rejects.toThrow(/at most 4/);
    await expect(repo.saveTeam({ id: T(1), season_year: 2026, name: 'Jim & Austin', player_a: pid(1), player_b: pid(2) })).rejects.toThrow(/Austin is already on Austin & Bryan/);
  });

  it('locks the format choices with the rest of the setup', async () => {
    await setup({ format: 'scramble', team_size: 2 });
    await repo.lockEvent(EV);
    await expect(repo.updateEvent(EV, { team_size: 4 })).rejects.toThrow(/setup is locked/);
    await expect(repo.updateEvent(EV, { format: 'individual' })).rejects.toThrow(/setup is locked/);
  });
});
