import { formatProblems } from './formats';
import { ratingComplete } from './handicap';
import { addDays } from './time';
import type { EventSession, LeagueEvent, Player, SessionAssignment, Team } from './types';

export const EVENTS_PER_SEASON = 5;
export const MAX_PLAYERS = 8;
export const MAX_PER_SESSION = 4;
export const MAX_SESSIONS = 2;
export const TEAM_SIZE = 2;
export const MAX_TEAMS = MAX_PLAYERS / TEAM_SIZE;

export class RuleError extends Error {}

const dayLabel = (n: number) => `Day ${n}`;

/** Session 2 must be the calendar day after session 1, in America/Chicago. */
export function checkSessionDate(
  sessions: EventSession[],
  eventId: string,
  sessionNumber: 1 | 2,
  date: string,
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RuleError('Enter a valid date.');
  const others = sessions.filter((s) => s.event_id === eventId && s.session_number !== sessionNumber);
  if (sessionNumber === 2) {
    const first = others.find((s) => s.session_number === 1);
    if (!first) throw new RuleError('Schedule Day 1 before adding Day 2.');
    const expected = addDays(first.session_date, 1);
    if (date !== expected) throw new RuleError(`Day 2 must be the day after Day 1 (${expected}, Central time).`);
  } else {
    const second = others.find((s) => s.session_number === 2);
    if (second && second.session_date !== addDays(date, 1)) {
      throw new RuleError(
        `Day 2 is set for ${second.session_date}, so Day 1 must be ${addDays(second.session_date, -1)}. Move or remove Day 2 first.`,
      );
    }
  }
}

export function checkStartTime(t: string): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new RuleError('Enter a valid start time.');
}

/** One session per player per event; at most four players per session. */
export function checkAssignment(
  sessions: EventSession[],
  assignments: SessionAssignment[],
  eventId: string,
  sessionId: string,
  playerId: string,
): void {
  const session = sessions.find((s) => s.id === sessionId && s.event_id === eventId);
  if (!session) throw new RuleError('That session does not belong to this event.');
  const existing = assignments.find((a) => a.event_id === eventId && a.player_id === playerId);
  if (existing) {
    if (existing.session_id === sessionId) throw new RuleError('That player is already in this session.');
    const other = sessions.find((s) => s.id === existing.session_id);
    throw new RuleError(
      `That player is already assigned to ${dayLabel(other?.session_number ?? 1)}. A player can play only one session per event.`,
    );
  }
  const count = assignments.filter((a) => a.session_id === sessionId).length;
  if (count >= MAX_PER_SESSION) {
    throw new RuleError(`${dayLabel(session.session_number)} already has ${MAX_PER_SESSION} players, the most one simulator session can hold.`);
  }
}

/** Everything that must be true before the event setup is locked and handicaps confirmed. */
export function lockProblems(
  event: LeagueEvent,
  sessions: EventSession[],
  assignments: SessionAssignment[],
  players: Player[],
  teams: Team[] = [],
): string[] {
  const problems: string[] = [];
  const ss = sessions.filter((s) => s.event_id === event.id).sort((a, b) => a.session_number - b.session_number);
  const as = assignments.filter((a) => a.event_id === event.id);
  if (!event.course_name.trim()) problems.push('Choose the simulator course.');
  if (!event.tees.trim()) problems.push('Choose the tees.');
  if (!ratingComplete(event)) problems.push('Enter the 9-hole par, course rating and slope.');
  if (ss.length === 0) problems.push('Schedule Day 1.');
  const perSession = ss.map((s) => as.filter((a) => a.session_id === s.id).length);
  const total = as.length;
  if (total === 0) problems.push('Assign players to a session.');
  if (perSession.some((n) => n > MAX_PER_SESSION)) problems.push('A session has more than four players.');
  if (total > 0 && total <= MAX_PER_SESSION && ss.length === 2) {
    problems.push(`With ${total} players, everyone plays together in one session. Move everyone to Day 1 and remove Day 2.`);
  }
  if (total > MAX_PER_SESSION) {
    if (ss.length < 2) problems.push(`${total} players need two sessions. Add Day 2.`);
    else if (perSession.some((n) => n === 0)) problems.push('Both sessions need players.');
  }
  if (total === 8 && ss.length === 2 && (perSession[0] !== 4 || perSession[1] !== 4)) {
    problems.push('An eight-player event plays four on Day 1 and four on Day 2.');
  }
  if (ss.length === 2 && ss[1].session_date !== addDays(ss[0].session_date, 1)) {
    problems.push('Day 2 must be the day after Day 1.');
  }
  for (const a of as) {
    const p = players.find((x) => x.id === a.player_id);
    if (!p) continue;
    if (p.handicap_index == null) problems.push(`${p.name} has no handicap index.`);
  }
  problems.push(...formatProblems(event, { sessions, assignments, teams, players }));
  return problems;
}

export const teamOf = (teams: Team[], season: number, playerId: string) =>
  teams.find((t) => t.season_year === season && (t.player_a === playerId || t.player_b === playerId));

export const teamName = (t: Team) => t.name.trim() || 'Team';

export function checkTeam(
  teams: Team[],
  players: Player[],
  t: { id?: string; season_year: number; name: string; player_a: string; player_b: string },
): void {
  if (!t.name.trim()) throw new RuleError('Give the team a name.');
  if (!t.player_a || !t.player_b) throw new RuleError('Pick two players for the team.');
  if (t.player_a === t.player_b) throw new RuleError('A team needs two different players.');
  const season = teams.filter((x) => x.season_year === t.season_year && x.id !== t.id);
  if (!t.id && season.length >= MAX_TEAMS) throw new RuleError(`The league has at most ${MAX_TEAMS} two-person teams.`);
  for (const pid of [t.player_a, t.player_b]) {
    const other = season.find((x) => x.player_a === pid || x.player_b === pid);
    if (other) {
      const n = players.find((p) => p.id === pid)?.name ?? 'That player';
      throw new RuleError(`${n} is already on ${teamName(other)}.`);
    }
  }
}

/** Both teammates go into the same session together, so the session needs two open spots. */
export function checkTeamAssignment(
  sessions: EventSession[],
  assignments: SessionAssignment[],
  eventId: string,
  sessionId: string,
  team: Team,
): void {
  checkAssignment(sessions, assignments, eventId, sessionId, team.player_a);
  checkAssignment(sessions, assignments, eventId, sessionId, team.player_b);
  const count = assignments.filter((a) => a.session_id === sessionId).length;
  if (count + TEAM_SIZE > MAX_PER_SESSION) {
    const s = sessions.find((x) => x.id === sessionId)!;
    throw new RuleError(`Day ${s.session_number} has room for ${MAX_PER_SESSION - count} more player, not a whole team.`);
  }
}
