import type { EventResult, LeagueEvent, Player, Team } from './types';

export interface StandingRow {
  player: Player;
  points: number;
  firsts: number;
  seconds: number;
  thirds: number;
  cumulativeNet: number;
  eventsPlayed: number;
  rank: number;
  /** Level with another player after every tiebreaker. */
  tied: boolean;
  /** Tied for the championship after all five events: a sudden-death playoff decides it. */
  playoff: boolean;
  /** Which tiebreaker separated this player from the one directly above, if any. */
  decidedBy: string | null;
}

const BREAKERS: { label: string; cmp: (a: StandingRow, b: StandingRow) => number }[] = [
  { label: 'points', cmp: (a, b) => b.points - a.points },
  { label: 'most 1st-place finishes', cmp: (a, b) => b.firsts - a.firsts },
  { label: 'most 2nd-place finishes', cmp: (a, b) => b.seconds - a.seconds },
  { label: 'most 3rd-place finishes', cmp: (a, b) => b.thirds - a.thirds },
  { label: 'lowest cumulative net', cmp: (a, b) => a.cumulativeNet - b.cumulativeNet },
];

const EPS = 1e-9;
const sign = (x: number) => (Math.abs(x) < EPS ? 0 : Math.sign(x));

export function seasonStandings(players: Player[], events: LeagueEvent[], results: EventResult[]): StandingRow[] {
  const published = new Set(events.filter((e) => e.status === 'published').map((e) => e.id));
  const rows: StandingRow[] = players
    .filter((p) => p.active || results.some((r) => r.player_id === p.id))
    .map((player) => {
      const mine = results.filter((r) => r.player_id === player.id && published.has(r.event_id));
      return {
        player,
        points: Math.round(mine.reduce((t, r) => t + Number(r.points), 0) * 100) / 100,
        firsts: mine.filter((r) => r.position === 1).length,
        seconds: mine.filter((r) => r.position === 2).length,
        thirds: mine.filter((r) => r.position === 3).length,
        cumulativeNet: mine.reduce((t, r) => t + (r.net ?? 0), 0),
        eventsPlayed: mine.filter((r) => r.status === 'completed').length,
        rank: 0,
        tied: false,
        playoff: false,
        decidedBy: null,
      };
    });

  const full = (a: StandingRow, b: StandingRow) => {
    for (const br of BREAKERS) {
      const c = sign(br.cmp(a, b));
      if (c !== 0) return c;
    }
    return a.player.name.localeCompare(b.player.name);
  };
  rows.sort(full);

  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (!prev) {
      cur.rank = 1;
      continue;
    }
    const breaker = BREAKERS.find((br) => sign(br.cmp(prev, cur)) !== 0);
    if (!breaker) {
      cur.rank = prev.rank;
      cur.tied = prev.tied = true;
    } else {
      cur.rank = i + 1;
      if (breaker.label !== 'points') cur.decidedBy = breaker.label;
    }
  }
  const seasonComplete = events.length >= 5 && events.every((e) => e.status === 'published');
  for (const r of rows) r.playoff = seasonComplete && r.tied && r.rank === 1;
  return rows;
}

export interface TeamStandingRow {
  team: Team;
  points: number;
  firsts: number;
  events: number;
}

/** Scramble events only: the points each team earned (every teammate also gets them individually). */
export function teamStandings(teams: Team[], events: LeagueEvent[], results: EventResult[]): TeamStandingRow[] {
  const published = new Set(events.filter((e) => e.status === 'published' && e.format === 'scramble').map((e) => e.id));
  return teams
    .map((team) => {
      const perEvent = new Map<string, EventResult>();
      for (const r of results) if (r.team_id === team.id && published.has(r.event_id)) perEvent.set(r.event_id, r);
      const rows = [...perEvent.values()];
      return {
        team,
        points: Math.round(rows.reduce((t, r) => t + Number(r.points), 0) * 100) / 100,
        firsts: rows.filter((r) => r.position === 1).length,
        events: rows.filter((r) => r.status === 'completed').length,
      };
    })
    .sort((a, b) => b.points - a.points || b.firsts - a.firsts || a.team.name.localeCompare(b.team.name));
}
