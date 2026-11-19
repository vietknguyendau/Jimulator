import { describe, expect, it } from 'vitest';
import { nineHoleCourseHandicap, roundHalfUp, strokesReceived } from '../src/lib/handicap';
import { buildLeaderboard, type LeaderboardEntry } from '../src/lib/leaderboard';
import { pointsTableFor, splitPoints } from '../src/lib/points';
import { addDays, leagueInstant, leagueToday } from '../src/lib/time';
import { seasonStandings } from '../src/lib/standings';
import type { EventResult, LeagueEvent, Player } from '../src/lib/types';

/** Nine holes adding up to `gross`. */
export const holes = (gross: number) => {
  const base = Math.floor(gross / 9);
  const extra = gross - base * 9;
  return Array.from({ length: 9 }, (_, i) => base + (i < extra ? 1 : 0));
};
const entry = (id: string, day: number, gross: number, strokes: number, status: LeaderboardEntry['status'] = 'completed'): LeaderboardEntry => ({
  player_id: id,
  session_number: day,
  status,
  hole_scores: holes(gross),
  strokes,
});

describe('points tables', () => {
  it('has the official 8- and 4-player tables', () => {
    expect(pointsTableFor(8)).toMatchObject({ ok: true, table: [16, 13, 11, 9, 7, 5, 3, 1] });
    expect(pointsTableFor(4)).toMatchObject({ ok: true, table: [12, 9, 6, 3] });
  });
  it('leaves other field sizes unresolved', () => {
    for (const n of [1, 2, 3, 5, 6, 7]) expect(pointsTableFor(n).ok).toBe(false);
  });
  it('splits tied positions evenly', () => {
    expect(splitPoints([16, 13, 11, 9, 7, 5, 3, 1], 1, 2)).toBe(14.5);
    expect(splitPoints([16, 13, 11, 9, 7, 5, 3, 1], 2, 3)).toBe(11);
    expect(splitPoints([12, 9, 6, 3], 3, 2)).toBe(4.5);
  });
});

describe('handicaps', () => {
  it('converts an index to a 9-hole course handicap', () => {
    // 14.7 index, 9-hole slope 120, rating 35.4, par 36 → 7.35 × 1.0619 − 0.6 = 7.205
    expect(nineHoleCourseHandicap(14.7, { slope9: 120, course_rating9: 35.4, par9: 36 })).toBeCloseTo(7.205, 3);
  });
  it('applies 80% and rounds once to the nearest stroke', () => {
    expect(strokesReceived(14.7, { slope9: 120, course_rating9: 35.4, par9: 36 }).strokes).toBe(6); // 5.76
    expect(strokesReceived(10, { slope9: 113, course_rating9: 36, par9: 36 }).strokes).toBe(4); // 4.0
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-0.5)).toBe(0);
  });
  it('matches the rulebook example: 42 gross with 4 strokes is 38 net', () => {
    const lb = buildLeaderboard([entry('a', 1, 42, 4)], 'starters');
    expect(lb.rows[0].net).toBe(38);
  });
});

describe('combined leaderboard', () => {
  it('acceptance 5: a four-player single-day event awards 12, 9, 6, 3', () => {
    const lb = buildLeaderboard(
      [entry('a', 1, 40, 0), entry('b', 1, 41, 0), entry('c', 1, 42, 0), entry('d', 1, 43, 0)],
      'starters',
    );
    expect(lb.lookup.ok).toBe(true);
    expect(lb.rows.map((r) => r.points)).toEqual([12, 9, 6, 3]);
    expect(lb.rows.map((r) => r.position)).toEqual([1, 2, 3, 4]);
  });

  it('acceptance 3: a Day 1 and a Day 2 player tie for first at 14.5; the next player is third', () => {
    const lb = buildLeaderboard(
      [
        entry('mon1', 1, 40, 4), // net 36
        entry('mon2', 1, 44, 4),
        entry('mon3', 1, 46, 4),
        entry('mon4', 1, 48, 4),
        entry('tue1', 2, 42, 6), // net 36
        entry('tue2', 2, 45, 6),
        entry('tue3', 2, 47, 6),
        entry('tue4', 2, 50, 6),
      ],
      'starters',
    );
    const [first, second, third] = lb.rows;
    expect([first.player_id, second.player_id].sort()).toEqual(['mon1', 'tue1']);
    expect(first.points).toBe(14.5);
    expect(second.points).toBe(14.5);
    expect(first.position).toBe(1);
    expect(second.position).toBe(1);
    expect(third.position).toBe(3);
    expect(third.points).toBe(11);
    expect(lb.rows.reduce((t, r) => t + r.points, 0)).toBe(65); // every point awarded exactly once
  });

  it('gives DNF and DNA players no points or position', () => {
    const lb = buildLeaderboard(
      [entry('a', 1, 40, 0), entry('b', 1, 41, 0), entry('c', 1, 42, 0), entry('d', 1, 30, 0, 'dnf')],
      'starters',
    );
    expect(lb.field).toBe(4);
    const d = lb.rows.find((r) => r.player_id === 'd')!;
    expect(d.points).toBe(0);
    expect(d.position).toBeNull();
    expect(lb.rows.slice(0, 3).map((r) => r.points)).toEqual([12, 9, 6]);
  });

  it('counts field size by the commissioner-approved basis', () => {
    const e = [entry('a', 1, 40, 0), entry('b', 1, 41, 0), entry('c', 1, 42, 0), entry('d', 1, 30, 0, 'dnf'), entry('e', 1, 0, 0, 'dna')];
    expect(buildLeaderboard(e, 'starters').field).toBe(4);
    expect(buildLeaderboard(e, 'finishers').field).toBe(3);
    expect(buildLeaderboard(e, 'finishers').lookup.ok).toBe(false);
  });
});

describe('league time zone', () => {
  it('finds the next calendar day across month and DST boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('turns a Central wall-clock time into the right instant', () => {
    expect(leagueInstant('2026-11-16', '18:00').toISOString()).toBe('2026-11-17T00:00:00.000Z'); // CST
    expect(leagueInstant('2026-07-01', '18:00').toISOString()).toBe('2026-07-01T23:00:00.000Z'); // CDT
  });
  it("uses Chicago's date, not UTC's", () => {
    expect(leagueToday(new Date('2026-11-17T03:00:00Z'))).toBe('2026-11-16');
  });
});

describe('season standings and tiebreakers', () => {
  const p = (id: string): Player => ({ id, name: id, ghin_number: null, handicap_index: 10, handicap_source: 'ghin', active: true });
  const ev = (id: string): LeagueEvent => ({
    id, format: 'individual', team_size: 2, counting_scores: 1, match_type: 'singles', hole_si: null, season_year: 2026, event_number: 1, name: id, course_name: 'x', tees: 'x', par9: 36, course_rating9: 36, slope9: 113,
    sim_settings: { green_speed: '', fairway_firmness: '', wind: '', putting: '', mulligans: '' }, status: 'published', locked_at: null, published_at: null,
  });
  const r = (event: string, player: string, position: number | null, points: number, net: number | null): EventResult => ({
    event_id: event, player_id: player, team_id: null, entry_id: null, detail: null, session_number: 1, status: net == null ? 'dna' : 'completed', position, tied: false, gross: net, strokes: 0, net, points,
  });

  it('breaks a points tie by most first-place finishes', () => {
    const s = seasonStandings([p('a'), p('b')], [ev('e1'), ev('e2')], [
      r('e1', 'a', 1, 12, 36), r('e1', 'b', 2, 9, 37),
      r('e2', 'a', 4, 3, 40), r('e2', 'b', 3, 6, 39),
    ]);
    expect(s[0].player.id).toBe('a');
    expect(s[0].points).toBe(15);
    expect(s[1].points).toBe(15);
    expect(s[1].rank).toBe(2);
    expect(s[1].decidedBy).toBe('most 1st-place finishes');
  });

  it('falls through to lowest cumulative net, then a playoff only for the title after all five events', () => {
    const results = [r('e1', 'a', 1, 14.5, 36), r('e1', 'b', 1, 14.5, 36)];
    const midSeason = seasonStandings([p('a'), p('b')], [ev('e1')], results);
    expect(midSeason.map((x) => [x.rank, x.tied, x.playoff])).toEqual([[1, true, false], [1, true, false]]);
    const five = ['e1', 'e2', 'e3', 'e4', 'e5'].map(ev);
    const final = seasonStandings([p('a'), p('b')], five, results);
    expect(final.every((x) => x.playoff)).toBe(true);
  });

  it('gives no-shows zero points', () => {
    const s = seasonStandings([p('a'), p('b')], [ev('e1')], [r('e1', 'a', 1, 12, 36), r('e1', 'b', null, 0, null)]);
    expect(s.find((x) => x.player.id === 'b')!.points).toBe(0);
  });
});
