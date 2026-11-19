// Event formats: who plays together, how handicaps are applied, and how results become points.
// supabase/migrations/20261119000006_formats.sql implements the same rules in the database;
// tests/formats.test.ts and tests/db.test.ts check that the two agree.
import { nineHoleCourseHandicap, ratingComplete, roundHalfUp } from './handicap';
import { buildLeaderboard, holesPlayed } from './leaderboard';
import { fieldSize, pointsTableFor } from './points';
import type {
  EventEntry, EventFormat, EventResult, EntryMember, LeagueEvent, ResultStatus, SessionAssignment, Snapshot, Team,
} from './types';

export const FORMAT_LABEL: Record<EventFormat, string> = {
  individual: 'Individual stroke play',
  scramble: 'Scramble',
  alt_shot: 'Alternate shot',
  shamble: 'Shamble',
  best_ball: 'Best ball',
  match_play: 'Match play',
};

/** Players per competitor: 1 (individual / singles), 2 (season teams) or 4 (session group). */
export function entrySize(e: Pick<LeagueEvent, 'format' | 'team_size' | 'match_type'>): 1 | 2 | 4 {
  if (e.format === 'individual') return 1;
  if (e.format === 'alt_shot') return 2;
  if (e.format === 'match_play') return e.match_type === 'fourball' ? 2 : 1;
  return e.team_size;
}

export const isTeamCard = (e: Pick<LeagueEvent, 'format'>) => e.format === 'scramble' || e.format === 'alt_shot';
export const isPerHole = (e: Pick<LeagueEvent, 'format'>) =>
  e.format === 'shamble' || e.format === 'best_ball' || e.format === 'match_play';
export const usesSeasonTeams = (e: Pick<LeagueEvent, 'format' | 'team_size' | 'match_type'>) => entrySize(e) === 2;

export function formatName(e: Pick<LeagueEvent, 'format' | 'team_size' | 'match_type'>): string {
  if (e.format === 'individual') return FORMAT_LABEL.individual;
  if (e.format === 'match_play') return e.match_type === 'fourball' ? 'Match play · 2 vs 2 best ball' : 'Match play · singles';
  return `${entrySize(e)}-person ${FORMAT_LABEL[e.format].toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Handicap allowances (World Handicap System recommendations)
// ---------------------------------------------------------------------------

/** Team-card formats: % of each player's course handicap, lowest handicap first. */
export function teamCardPercents(e: Pick<LeagueEvent, 'format' | 'team_size'>): number[] {
  if (e.format === 'alt_shot') return [0.5, 0.5];
  return e.team_size === 4 ? [0.25, 0.2, 0.15, 0.1] : [0.35, 0.15];
}

export function teamCardStrokes(e: Pick<LeagueEvent, 'format' | 'team_size'>, chs: number[]): number {
  const pct = teamCardPercents(e);
  const sorted = [...chs].sort((a, b) => a - b);
  return roundHalfUp(sorted.reduce((t, ch, i) => t + ch * (pct[i] ?? 0), 0));
}

/** Per-hole formats: each player's allowance before strokes are spread over the holes. */
export function perHoleAllowance(e: Pick<LeagueEvent, 'format' | 'team_size' | 'counting_scores' | 'match_type'>): number {
  if (e.format === 'match_play') return e.match_type === 'fourball' ? 0.9 : 1;
  if (e.team_size === 4) return e.counting_scores >= 3 ? 1 : e.counting_scores === 2 ? 0.85 : 0.75;
  return e.counting_scores >= 2 ? 1 : 0.85;
}

export function allowanceText(e: LeagueEvent): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (e.format === 'individual') return '80% of each 9-hole course handicap, taken off the total.';
  if (isTeamCard(e)) {
    const p = teamCardPercents(e);
    if (e.format === 'alt_shot') return 'Team strokes = 50% of the two players’ combined 9-hole course handicaps, taken off the total.';
    return `Team strokes = ${p.map(pct).join(' / ')} of the players’ course handicaps, lowest first, taken off the total.`;
  }
  if (e.format === 'match_play') {
    return `${pct(perHoleAllowance(e))} of each course handicap; the lowest player in the match plays off zero and the others get the difference, one stroke per hole on the hardest holes.`;
  }
  return `${pct(perHoleAllowance(e))} of each player’s course handicap, given as strokes on the hardest holes. The best ${e.counting_scores} net score${e.counting_scores > 1 ? 's' : ''} count on each hole.`;
}

// ---------------------------------------------------------------------------
// Strokes hole by hole
// ---------------------------------------------------------------------------

/** Rank of each of the 9 holes by the course card's stroke index (1 = hardest). Ties go to the earlier hole. */
export function siRanks(si: (number | null)[]): number[] {
  return si.map((v, i) => 1 + si.filter((w, j) => (w ?? 99) < (v ?? 99) || ((w ?? 99) === (v ?? 99) && j < i)).length);
}

export function strokeIndexProblem(si: (number | null)[] | null): string | null {
  if (!si || si.length !== 9 || si.some((v) => v == null)) return 'Enter the stroke index (handicap hole) for all 9 holes from the course card.';
  if (si.some((v) => !Number.isInteger(v) || v! < 1 || v! > 18)) return 'Stroke indexes are 1–18.';
  if (new Set(si).size !== 9) return 'Each hole needs a different stroke index.';
  return null;
}

/** Strokes a player with `ph` strokes over 9 holes receives on the hole ranked `r`. Plus handicaps give strokes back on the easiest holes. */
export function holeStrokes(ph: number, r: number): number {
  if (ph >= 0) return Math.floor(ph / 9) + (r <= ph % 9 ? 1 : 0);
  const n = -ph;
  const back = Math.floor(n / 9) + (r > 9 - (n % 9) ? 1 : 0);
  return back === 0 ? 0 : -back;
}

// ---------------------------------------------------------------------------
// Entries: who competes as a unit, built when the event is locked
// ---------------------------------------------------------------------------

export interface PlannedEntry {
  key: string;
  session_id: string;
  team_id: string | null;
  match_slot: 1 | 2 | null;
  strokes: number | null;
  members: { player_id: string; course_handicap: number; playing_handicap: number | null }[];
}

type Ctx = Pick<Snapshot, 'sessions' | 'assignments' | 'teams' | 'players'>;

const nameOf = (c: Ctx, id: string) => c.players.find((p) => p.id === id)?.name ?? 'A player';
export const teamOfPlayer = (teams: Team[], season: number, playerId: string) =>
  teams.find((t) => t.season_year === season && (t.player_a === playerId || t.player_b === playerId));
const teamLabel = (t: Team) => t.name.trim() || 'Team';

/** Everything about groups and pairings that must be right before a team or match event locks. */
export function formatProblems(e: LeagueEvent, c: Ctx): string[] {
  if (e.format === 'individual') return [];
  const problems: string[] = [];
  const as = c.assignments.filter((a) => a.event_id === e.id);
  const ss = c.sessions.filter((s) => s.event_id === e.id);
  const size = entrySize(e);
  if (isPerHole(e)) {
    const p = strokeIndexProblem(e.hole_si);
    if (p) problems.push(p);
  }
  if ((e.format === 'best_ball' || e.format === 'shamble') && (e.counting_scores < 1 || e.counting_scores > (size === 4 ? 3 : 2))) {
    problems.push(`Pick how many scores count on each hole (1–${size === 4 ? 3 : 2}).`);
  }
  if (size === 2) {
    for (const a of as) {
      const t = teamOfPlayer(c.teams, e.season_year, a.player_id);
      if (!t) {
        problems.push(`${nameOf(c, a.player_id)} isn't on a 2-person team. Add them to a team in the league office.`);
        continue;
      }
      const mate = t.player_a === a.player_id ? t.player_b : t.player_a;
      const ma = as.find((x) => x.player_id === mate);
      if (!ma) problems.push(`${teamLabel(t)}: ${nameOf(c, mate)} isn't assigned. Both teammates play together.`);
      else if (ma.session_id !== a.session_id) problems.push(`${teamLabel(t)}: teammates must play the same day.`);
    }
  }
  for (const s of ss) {
    const here = as.filter((a) => a.session_id === s.id);
    if (!here.length) continue;
    if (size === 4 && here.length !== 4) problems.push(`Day ${s.session_number} needs exactly 4 players to make a 4-person team.`);
    if (e.format === 'match_play' && size === 2 && here.length !== 4) {
      problems.push(`Day ${s.session_number} needs two teams (4 players) for a 2 vs 2 match.`);
    }
    if (e.format === 'match_play' && size === 1) {
      if (here.some((a) => a.match_slot == null)) problems.push(`Day ${s.session_number}: put every player in Match 1 or Match 2.`);
      for (const slot of [1, 2] as const) {
        const n = here.filter((a) => a.match_slot === slot).length;
        if (n !== 0 && n !== 2) problems.push(`Day ${s.session_number}, Match ${slot} needs exactly 2 players.`);
      }
    }
  }
  return [...new Set(problems)];
}

/**
 * The competitors for a team or match event. `chOf` gives each player's unrounded
 * 9-hole course handicap (rounded to 4 decimals, as the database stores it).
 */
export function planEntries(e: LeagueEvent, c: Ctx, chOf: (playerId: string) => number | null): PlannedEntry[] {
  const as = c.assignments.filter((a) => a.event_id === e.id);
  const size = entrySize(e);
  const groups: { key: string; session_id: string; team_id: string | null; match_slot: 1 | 2 | null; players: string[] }[] = [];
  if (size === 2) {
    for (const t of c.teams.filter((x) => x.season_year === e.season_year)) {
      const a = as.find((x) => x.player_id === t.player_a);
      const b = as.find((x) => x.player_id === t.player_b);
      if (a && b && a.session_id === b.session_id) {
        groups.push({ key: t.id, session_id: a.session_id, team_id: t.id, match_slot: e.format === 'match_play' ? 1 : null, players: [t.player_a, t.player_b] });
      }
    }
  } else if (size === 4) {
    for (const s of c.sessions.filter((x) => x.event_id === e.id)) {
      const here = as.filter((a) => a.session_id === s.id);
      if (here.length) groups.push({ key: s.id, session_id: s.id, team_id: null, match_slot: null, players: here.map((a) => a.player_id) });
    }
  } else {
    for (const a of as) groups.push({ key: a.player_id, session_id: a.session_id, team_id: null, match_slot: a.match_slot, players: [a.player_id] });
  }

  const entries: PlannedEntry[] = groups.map((g) => {
    const members = g.players.map((pid) => ({ player_id: pid, course_handicap: chOf(pid) ?? 0, playing_handicap: null as number | null }));
    let strokes: number | null = null;
    if (isTeamCard(e)) strokes = teamCardStrokes(e, members.map((m) => m.course_handicap));
    else for (const m of members) m.playing_handicap = roundHalfUp(m.course_handicap * perHoleAllowance(e));
    return { key: g.key, session_id: g.session_id, team_id: g.team_id, match_slot: g.match_slot, strokes, members };
  });

  if (e.format === 'match_play') {
    // Strokes off the low player in each match.
    const matchKey = (x: PlannedEntry) => `${x.session_id}:${x.match_slot}`;
    for (const k of new Set(entries.map(matchKey))) {
      const ms = entries.filter((x) => matchKey(x) === k).flatMap((x) => x.members);
      const low = Math.min(...ms.map((m) => m.playing_handicap!));
      for (const m of ms) m.playing_handicap = m.playing_handicap! - low;
    }
  }
  return entries;
}

/** Course handicap as stored at lock time (4 decimals). */
export const lockedCourseHandicap = (index: number, e: LeagueEvent) =>
  ratingComplete(e) ? Math.round(nineHoleCourseHandicap(index, e) * 10000) / 10000 : null;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface OutcomeRow {
  key: string; // entry id (team/match) or player id (individual)
  entry_id: string | null;
  session_number: number;
  status: ResultStatus;
  position: number | null;
  tied: boolean;
  gross: number | null;
  strokes: number | null;
  net: number | null;
  points: number;
  player_ids: string[];
  detail: string | null;
}

export interface MatchRow {
  session_number: number;
  match_slot: number;
  a: string; // entry ids
  b: string;
  winner: string | null; // entry id, null = halved / no result
  margin: number; // holes up for the winner (0 if halved)
  forfeit: boolean;
  complete: boolean;
}

export interface Outcome {
  rows: OutcomeRow[];
  matches: MatchRow[];
  /** One row per player, ready to store as official results. */
  results: Omit<EventResult, 'event_id'>[];
  field: number;
  allResolved: boolean;
  blockers: string[];
}

const playerCard = (s: Snapshot, e: LeagueEvent, playerId: string) => {
  const a = s.assignments.find((x) => x.event_id === e.id && x.player_id === playerId);
  const sc = a ? s.scores.find((r) => r.assignment_id === a.id) : undefined;
  return { holes: sc?.hole_scores ?? Array(9).fill(null), status: sc?.status ?? ('pending' as ResultStatus) };
};

export function entryName(s: Pick<Snapshot, 'teams' | 'players' | 'sessions'>, en: Pick<EventEntry, 'team_id' | 'session_id'>, members: string[]): string {
  if (en.team_id) {
    const t = s.teams.find((x) => x.id === en.team_id);
    if (t) return teamLabel(t);
  }
  if (members.length === 1) return s.players.find((p) => p.id === members[0])?.name ?? 'Player';
  const sess = s.sessions.find((x) => x.id === en.session_id);
  return `Day ${sess?.session_number ?? '?'} team`;
}

/** Team / per-hole score for one entry from what the viewer can see. */
function entryScore(s: Snapshot, e: LeagueEvent, en: EventEntry, members: EntryMember[]) {
  if (isTeamCard(e)) {
    const sc = s.entryScores.find((r) => r.entry_id === en.id);
    const holes = sc?.hole_scores ?? Array(9).fill(null);
    const status = sc?.status ?? 'pending';
    const played = holesPlayed(holes);
    const gross = played ? holes.reduce<number>((t, h) => t + (h ?? 0), 0) : null;
    return { status, gross, net: status === 'completed' && gross != null ? gross - (en.strokes ?? 0) : null, holeNets: null as (number | null)[] | null };
  }
  const ranks = siRanks(e.hole_si ?? Array(9).fill(null));
  const cards = members.map((m) => ({ m, ...playerCard(s, e, m.player_id) }));
  if (cards.some((c) => c.status === 'pending')) return { status: 'pending' as ResultStatus, gross: null, net: null, holeNets: null };
  if (cards.every((c) => c.status === 'dna')) return { status: 'dna' as ResultStatus, gross: null, net: null, holeNets: null };
  const k = e.format === 'match_play' ? 1 : e.counting_scores;
  let gross = 0;
  let net = 0;
  let complete = true;
  const holeNets: (number | null)[] = [];
  for (let h = 0; h < 9; h++) {
    const scored = cards
      .filter((c) => c.status !== 'dna' && c.holes[h] != null)
      .map((c) => ({ g: c.holes[h]!, n: c.holes[h]! - holeStrokes(c.m.playing_handicap ?? 0, ranks[h]) }))
      .sort((x, y) => x.n - y.n || x.g - y.g)
      .slice(0, k);
    if (scored.length < k) {
      complete = false;
      holeNets.push(null);
      continue;
    }
    gross += scored.reduce((t, x) => t + x.g, 0);
    const hn = scored.reduce((t, x) => t + x.n, 0);
    net += hn;
    holeNets.push(hn);
  }
  return complete
    ? { status: 'completed' as ResultStatus, gross, net, holeNets }
    : { status: 'dnf' as ResultStatus, gross: null, net: null, holeNets };
}

export function computeOutcome(s: Snapshot, eventId: string): Outcome {
  const e = s.events.find((x) => x.id === eventId)!;
  const sessionNo = (id: string) => s.sessions.find((x) => x.id === id)?.session_number ?? 1;

  if (e.format === 'individual') {
    const entries = s.assignments
      .filter((a) => a.event_id === e.id)
      .map((a) => ({ player_id: a.player_id, session_number: sessionNo(a.session_id), strokes: a.strokes, ...((c) => ({ status: c.status, hole_scores: c.holes }))(playerCard(s, e, a.player_id)) }));
    const lb = buildLeaderboard(entries, s.settings.field_size_basis);
    const rows: OutcomeRow[] = lb.rows.map((r) => ({
      key: r.player_id, entry_id: null, session_number: r.session_number, status: r.status, position: r.position, tied: r.tied,
      gross: r.status === 'dna' ? null : r.gross, strokes: r.strokes, net: r.net, points: r.points, player_ids: [r.player_id], detail: null,
    }));
    const blockers = [...(!lb.allResolved ? ['Every player must be marked completed, did not finish, or did not attend.'] : []), ...(lb.allResolved && !lb.lookup.ok ? [lb.lookup.reason] : [])];
    return { rows, matches: [], results: rows.map((r) => resultFor(r, r.key, null)), field: lb.field, allResolved: lb.allResolved, blockers };
  }

  const entries = s.entries.filter((x) => x.event_id === e.id);
  const membersOf = (en: EventEntry) => s.entryMembers.filter((m) => m.entry_id === en.id);
  const scored = entries.map((en) => ({ en, members: membersOf(en), ...entryScore(s, e, en, membersOf(en)) }));
  const allResolved = scored.length > 0 && scored.every((x) => x.status !== 'pending');
  const unit = isTeamCard(e) ? 'team' : 'player';
  const blockers: string[] = allResolved ? [] : [`Every ${unit} must be marked completed, did not finish, or did not attend.`];

  if (e.format === 'match_play') return matchOutcome(s, e, scored, allResolved, blockers, sessionNo);

  // Team leaderboard: each finishing team covers as many places as it has players;
  // tied teams share their combined places; every teammate gets the average of those places.
  const field = scored
    .filter((x) => x.status === 'completed' || (s.settings.field_size_basis === 'starters' && x.status === 'dnf'))
    .reduce((t, x) => t + x.members.length, 0);
  const lookup = pointsTableFor(field);
  if (allResolved && !lookup.ok) blockers.push(lookup.reason);
  const fin = scored.filter((x) => x.status === 'completed').sort((a, b) => a.net! - b.net!);
  const rows: OutcomeRow[] = [];
  let place = 1;
  let i = 0;
  while (i < fin.length) {
    let j = i;
    while (j + 1 < fin.length && fin[j + 1].net === fin[i].net) j++;
    const group = fin.slice(i, j + 1);
    const places = group.reduce((t, x) => t + x.members.length, 0);
    let total = 0;
    if (lookup.ok) for (let p = place; p < place + places; p++) total += lookup.table[p - 1] ?? 0;
    const pts = Math.round((total / places) * 100) / 100;
    for (const x of group) rows.push(teamRow(x, i + 1, group.length > 1, lookup.ok ? pts : 0));
    place += places;
    i = j + 1;
  }
  for (const st of ['pending', 'dnf', 'dna'] as ResultStatus[]) {
    for (const x of scored.filter((y) => y.status === st)) rows.push(teamRow(x, null, false, 0));
  }
  function teamRow(x: (typeof scored)[number], position: number | null, tied: boolean, points: number): OutcomeRow {
    return {
      key: x.en.id, entry_id: x.en.id, session_number: sessionNo(x.en.session_id), status: x.status, position, tied,
      gross: x.status === 'dna' ? null : x.gross, strokes: x.en.strokes, net: x.net, points,
      player_ids: x.members.map((m) => m.player_id), detail: null,
    };
  }
  const results = rows.flatMap((r) => {
    const en = entries.find((x) => x.id === r.entry_id)!;
    return r.player_ids.map((pid) => resultFor(r, pid, en.team_id));
  });
  return { rows, matches: [], results, field, allResolved, blockers };
}

function resultFor(r: OutcomeRow, playerId: string, teamId: string | null): Omit<EventResult, 'event_id'> {
  return {
    player_id: playerId, team_id: teamId, entry_id: r.entry_id, session_number: r.session_number,
    status: r.status === 'pending' ? 'dnf' : (r.status as EventResult['status']),
    position: r.position, tied: r.tied, gross: r.gross, strokes: r.strokes, net: r.net, points: r.points, detail: r.detail,
  };
}

function matchOutcome(
  s: Snapshot,
  e: LeagueEvent,
  scored: { en: EventEntry; members: EntryMember[]; status: ResultStatus; holeNets: (number | null)[] | null }[],
  allResolved: boolean,
  blockers: string[],
  sessionNo: (id: string) => number,
): Outcome {
  const win = s.settings.match_win_points;
  const halve = s.settings.match_halve_points;
  if (win == null || halve == null) blockers.push('Set the match play points for a win and a halve in the league office.');
  const byMatch = new Map<string, typeof scored>();
  for (const x of scored) {
    const k = `${x.en.session_id}:${x.en.match_slot}`;
    byMatch.set(k, [...(byMatch.get(k) ?? []), x]);
  }
  const matches: MatchRow[] = [];
  const outcomeOf = new Map<string, { points: number; detail: string }>();
  const label = (x: (typeof scored)[number]) => entryName(s, x.en, x.members.map((m) => m.player_id));
  for (const pair of byMatch.values()) {
    if (pair.length !== 2) continue;
    const [a, b] = [...pair].sort((x, y) => x.en.id.localeCompare(y.en.id));
    const aDone = a.status === 'completed';
    const bDone = b.status === 'completed';
    let winner: typeof a | null = null;
    let margin = 0;
    let forfeit = false;
    if (aDone && bDone) {
      for (let h = 0; h < 9; h++) margin += Math.sign(b.holeNets![h]! - a.holeNets![h]!);
      winner = margin > 0 ? a : margin < 0 ? b : null;
      margin = Math.abs(margin);
    } else if (aDone !== bDone && a.status !== 'pending' && b.status !== 'pending') {
      winner = aDone ? a : b;
      forfeit = true;
    }
    const complete = a.status !== 'pending' && b.status !== 'pending';
    matches.push({ session_number: sessionNo(a.en.session_id), match_slot: a.en.match_slot ?? 1, a: a.en.id, b: b.en.id, winner: winner?.en.id ?? null, margin, forfeit, complete });
    for (const [me, them] of [[a, b], [b, a]] as const) {
      let detail: string;
      let points = 0;
      if (!complete) detail = `vs ${label(them)}`;
      else if (winner === me) {
        detail = forfeit ? `Won by forfeit vs ${label(them)}` : `Won ${margin} up vs ${label(them)}`;
        points = win ?? 0;
      } else if (winner === them) detail = forfeit ? `Lost by forfeit to ${label(them)}` : `Lost ${margin} down to ${label(them)}`;
      else if (aDone && bDone) {
        detail = `Halved with ${label(them)}`;
        points = halve ?? 0;
      } else detail = `No result vs ${label(them)}`;
      outcomeOf.set(me.en.id, { points, detail });
    }
  }
  const results: Omit<EventResult, 'event_id'>[] = [];
  const rows: OutcomeRow[] = [];
  const ranks = siRanks(e.hole_si ?? Array(9).fill(null));
  for (const x of scored) {
    const o = outcomeOf.get(x.en.id) ?? { points: 0, detail: 'No opponent' };
    rows.push({
      key: x.en.id, entry_id: x.en.id, session_number: sessionNo(x.en.session_id), status: x.status, position: null, tied: false,
      gross: null, strokes: null, net: null, points: o.points, player_ids: x.members.map((m) => m.player_id), detail: o.detail,
    });
    for (const m of x.members) {
      const c = playerCard(s, e, m.player_id);
      const done = c.status === 'completed' && holesPlayed(c.holes) === 9;
      const gross = done ? c.holes.reduce<number>((t, h) => t + (h ?? 0), 0) : null;
      const net = done ? c.holes.reduce<number>((t, h, i) => t + (h ?? 0) - holeStrokes(m.playing_handicap ?? 0, ranks[i]), 0) : null;
      results.push({
        player_id: m.player_id, team_id: x.en.team_id, entry_id: x.en.id, session_number: sessionNo(x.en.session_id),
        status: c.status === 'pending' ? 'dnf' : (c.status as EventResult['status']),
        position: null, tied: false, gross, strokes: m.playing_handicap, net, points: o.points, detail: o.detail,
      });
    }
  }
  return { rows, matches, results, field: fieldSize(scored.map((x) => x.status), s.settings.field_size_basis), allResolved, blockers };
}

/** Helper for screens: a session's assignments for an event. */
export const sessionAssignments = (as: SessionAssignment[], sessionId: string) => as.filter((a) => a.session_id === sessionId);
