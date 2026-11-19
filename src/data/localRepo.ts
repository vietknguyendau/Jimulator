// Demo/offline store: same rules as the Supabase database, kept in browser storage.
// Used when no Supabase project is configured, and by the tests.
import { ratingComplete, scrambleTeamStrokes, strokesReceived } from '../lib/handicap';
import { buildLeaderboard, buildTeamLeaderboard } from '../lib/leaderboard';
import { checkAssignment, checkSessionDate, checkStartTime, checkTeam, checkTeamAssignment, lockProblems, MAX_PER_SESSION, MAX_PLAYERS, RuleError, teamName } from '../lib/schedule';
import type { EventResult, ResultStatus, Snapshot } from '../lib/types';
import { checkScoreEntry, type EventSetupPatch, type PlayerInput, type Repo, type TeamInput } from './repo';

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export function memoryKV(): KV {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

export function browserKV(): KV {
  try {
    const t = '__jim_test';
    window.localStorage.setItem(t, '1');
    window.localStorage.removeItem(t);
    return window.localStorage;
  } catch {
    return memoryKV();
  }
}

export const DEMO_COMMISSIONER = { email: 'commissioner@jimulator.demo', password: 'jimulator' };

const STATE_KEY = 'jimulator.demo.state.v1';
const AUTH_KEY = 'jimulator.demo.auth.v1';

let counter = 0;
const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export class LocalRepo implements Repo {
  readonly mode = 'demo' as const;
  constructor(private kv: KV, private seed: () => Snapshot) {}

  private read(): Snapshot {
    const raw = this.kv.getItem(STATE_KEY);
    if (raw) {
      try {
        const s = JSON.parse(raw) as Snapshot;
        // Demo data saved before scramble support: fill in the new fields.
        s.teams ??= [];
        s.eventTeams ??= [];
        s.teamScores ??= [];
        for (const e of s.events) e.format ??= 'individual';
        for (const r of s.results) r.team_id ??= null;
        return s;
      } catch {
        /* fall through to reseed */
      }
    }
    const s = this.seed();
    this.write(s);
    return s;
  }
  private write(s: Snapshot) {
    this.kv.setItem(STATE_KEY, JSON.stringify(s));
  }
  private mutate(fn: (s: Snapshot) => void) {
    if (!this.authed()) throw new Error('Only the commissioner can do that.');
    const s = this.read();
    fn(s);
    this.write(s);
  }
  private authed() {
    return this.kv.getItem(AUTH_KEY) === DEMO_COMMISSIONER.email;
  }

  resetDemo() {
    this.kv.removeItem(STATE_KEY);
  }

  async load(): Promise<Snapshot> {
    const s = clone(this.read());
    if (!this.authed()) {
      // Public view: scores stay private until official results are published.
      const published = new Set(s.events.filter((e) => e.status === 'published').map((e) => e.id));
      const visible = new Set(s.assignments.filter((a) => published.has(a.event_id)).map((a) => a.id));
      s.scores = s.scores.filter((r) => visible.has(r.assignment_id));
      s.teamScores = s.teamScores.filter((r) => published.has(r.event_id));
    }
    return s;
  }
  async currentUser() {
    return this.authed() ? { email: DEMO_COMMISSIONER.email } : null;
  }
  async isCommissioner() {
    return this.authed();
  }
  async signIn(email: string, password: string) {
    if (email.trim().toLowerCase() !== DEMO_COMMISSIONER.email || password !== DEMO_COMMISSIONER.password) {
      throw new Error('Wrong email or password.');
    }
    this.kv.setItem(AUTH_KEY, DEMO_COMMISSIONER.email);
  }
  async signOut() {
    this.kv.removeItem(AUTH_KEY);
  }

  async updateSettings(patch: Parameters<Repo['updateSettings']>[0]) {
    this.mutate((s) => Object.assign(s.settings, patch));
  }

  async savePlayer(p: PlayerInput) {
    this.mutate((s) => {
      if (!p.name.trim()) throw new RuleError('Enter a name.');
      const others = s.players.filter((x) => x.id !== p.id && x.active).length;
      if (p.active && others >= MAX_PLAYERS) throw new RuleError('The league has an 8-player maximum.');
      if (p.id) {
        const cur = s.players.find((x) => x.id === p.id);
        if (!cur) throw new Error('Player not found.');
        Object.assign(cur, p);
      } else s.players.push({ ...p, id: uid() });
    });
  }

  async saveTeam(t: TeamInput) {
    this.mutate((s) => {
      checkTeam(s.teams, s.players, t);
      if (t.id) {
        const cur = s.teams.find((x) => x.id === t.id);
        if (!cur) throw new Error('Team not found.');
        Object.assign(cur, t);
      } else s.teams.push({ ...t, id: uid() });
    });
  }

  async deleteTeam(teamId: string) {
    this.mutate((s) => {
      if (s.eventTeams.some((x) => x.team_id === teamId) || s.results.some((r) => r.team_id === teamId)) {
        throw new RuleError("This team has played or is locked into an event, so it can't be removed. Rename it or change players instead.");
      }
      s.teams = s.teams.filter((x) => x.id !== teamId);
    });
  }

  async assignTeam(eventId: string, sessionId: string, teamId: string) {
    this.mutate((s) => {
      this.draftEvent(s, eventId);
      const team = s.teams.find((t) => t.id === teamId);
      if (!team) throw new Error('Team not found.');
      checkTeamAssignment(s.sessions, s.assignments, eventId, sessionId, team);
      for (const pid of [team.player_a, team.player_b]) {
        s.assignments.push({
          id: uid(), event_id: eventId, session_id: sessionId, player_id: pid,
          index_used: null, course_handicap: null, strokes: null, handicap_confirmed_at: null,
        });
      }
    });
  }

  async saveTeamScore(eventId: string, teamId: string, holes: (number | null)[], status: ResultStatus) {
    this.mutate((s) => {
      const et = s.eventTeams.find((x) => x.event_id === eventId && x.team_id === teamId);
      if (!et) throw new Error('That team is not in this event.');
      const ev = s.events.find((e) => e.id === eventId)!;
      const sess = s.sessions.find((x) => x.id === et.session_id)!;
      if (ev.status === 'draft') throw new RuleError('Lock the event and confirm handicaps before entering scores.');
      if (ev.status === 'published') throw new RuleError('Results are published. Unpublish the event to correct a score.');
      if (sess.status === 'resolved') throw new RuleError(`Day ${sess.session_number} is marked complete. Reopen it to change a score.`);
      checkScoreEntry(holes, status, 'team');
      const row = s.teamScores.find((r) => r.event_id === eventId && r.team_id === teamId);
      if (row) Object.assign(row, { hole_scores: holes, status, updated_at: now() });
      else s.teamScores.push({ event_id: eventId, team_id: teamId, hole_scores: holes, status, updated_at: now() });
    });
  }

  async updateEvent(eventId: string, patch: EventSetupPatch) {
    this.mutate((s) => {
      const ev = s.events.find((e) => e.id === eventId);
      if (!ev) throw new Error('Event not found.');
      const setupKeys: (keyof EventSetupPatch)[] = ['format', 'course_name', 'tees', 'par9', 'course_rating9', 'slope9', 'sim_settings'];
      if (ev.status !== 'draft' && setupKeys.some((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(ev[k]))) {
        throw new RuleError("This event's setup is locked. Unlock it before changing the format, course, tees or simulator settings.");
      }
      Object.assign(ev, patch);
    });
  }

  async saveSession(eventId: string, n: 1 | 2, date: string, startTime: string) {
    this.mutate((s) => {
      const ev = s.events.find((e) => e.id === eventId);
      if (!ev) throw new Error('Event not found.');
      if (ev.status === 'published') throw new RuleError('Results are published; this event can no longer be rescheduled.');
      checkStartTime(startTime);
      checkSessionDate(s.sessions, eventId, n, date);
      const cur = s.sessions.find((x) => x.event_id === eventId && x.session_number === n);
      if (cur) {
        cur.session_date = date;
        cur.start_time = startTime;
      } else {
        if (ev.status !== 'draft') throw new RuleError('Unlock the event before adding a session.');
        s.sessions.push({ id: uid(), event_id: eventId, session_number: n, session_date: date, start_time: startTime, status: 'scheduled', resolved_at: null });
      }
    });
  }

  async deleteSession(sessionId: string) {
    this.mutate((s) => {
      const sess = s.sessions.find((x) => x.id === sessionId);
      if (!sess) return;
      const ev = s.events.find((e) => e.id === sess.event_id)!;
      if (ev.status !== 'draft') throw new RuleError('Unlock the event before removing a session.');
      if (sess.session_number === 1 && s.sessions.some((x) => x.event_id === ev.id && x.session_number === 2)) {
        throw new RuleError('Remove Day 2 before removing Day 1.');
      }
      if (s.assignments.some((a) => a.session_id === sessionId)) throw new RuleError("Move or remove this session's players first.");
      s.sessions = s.sessions.filter((x) => x.id !== sessionId);
    });
  }

  private draftEvent(s: Snapshot, eventId: string) {
    const ev = s.events.find((e) => e.id === eventId);
    if (!ev) throw new Error('Event not found.');
    if (ev.status !== 'draft') throw new RuleError('Unlock the event before changing groups.');
    return ev;
  }

  async assign(eventId: string, sessionId: string, playerId: string) {
    this.mutate((s) => {
      this.draftEvent(s, eventId);
      checkAssignment(s.sessions, s.assignments, eventId, sessionId, playerId);
      s.assignments.push({
        id: uid(), event_id: eventId, session_id: sessionId, player_id: playerId,
        index_used: null, course_handicap: null, strokes: null, handicap_confirmed_at: null,
      });
    });
  }

  async moveAssignment(assignmentId: string, sessionId: string) {
    this.mutate((s) => {
      const a = s.assignments.find((x) => x.id === assignmentId);
      if (!a) throw new Error('Assignment not found.');
      this.draftEvent(s, a.event_id);
      if (a.session_id === sessionId) return;
      const sess = s.sessions.find((x) => x.id === sessionId && x.event_id === a.event_id);
      if (!sess) throw new RuleError('That session does not belong to this event.');
      if (s.assignments.filter((x) => x.session_id === sessionId).length >= MAX_PER_SESSION) {
        throw new RuleError(`Day ${sess.session_number} already has 4 players, the most one simulator session can hold.`);
      }
      a.session_id = sessionId;
    });
  }

  async unassign(assignmentId: string) {
    this.mutate((s) => {
      const a = s.assignments.find((x) => x.id === assignmentId);
      if (!a) return;
      this.draftEvent(s, a.event_id);
      s.assignments = s.assignments.filter((x) => x.id !== assignmentId);
    });
  }

  async lockEvent(eventId: string) {
    this.mutate((s) => {
      const ev = s.events.find((e) => e.id === eventId);
      if (!ev) throw new Error('Event not found.');
      if (ev.status !== 'draft') throw new RuleError('This event is already locked.');
      const problems = lockProblems(ev, s.sessions, s.assignments, s.players, s.teams);
      if (problems.length) throw new RuleError(problems[0]);
      if (!ratingComplete(ev)) throw new RuleError('Enter the 9-hole rating.');
      const t = now();
      for (const a of s.assignments.filter((x) => x.event_id === eventId)) {
        const p = s.players.find((x) => x.id === a.player_id)!;
        const h = strokesReceived(p.handicap_index!, ev);
        a.index_used = p.handicap_index;
        a.course_handicap = Math.round(h.courseHandicap * 10000) / 10000;
        a.strokes = h.strokes;
        a.handicap_confirmed_at = t;
        if (ev.format === 'individual' && !s.scores.some((r) => r.assignment_id === a.id)) {
          s.scores.push({ assignment_id: a.id, hole_scores: Array(9).fill(null), status: 'pending', updated_at: t });
        }
      }
      if (ev.format === 'scramble') {
        const mine = s.assignments.filter((x) => x.event_id === eventId);
        for (const team of s.teams.filter((x) => x.season_year === ev.season_year)) {
          const a = mine.find((x) => x.player_id === team.player_a);
          const b = mine.find((x) => x.player_id === team.player_b);
          if (!a || !b) continue;
          s.eventTeams.push({
            event_id: eventId, team_id: team.id, session_id: a.session_id, player_a: team.player_a, player_b: team.player_b,
            ch_a: a.course_handicap!, ch_b: b.course_handicap!, strokes: scrambleTeamStrokes(a.course_handicap!, b.course_handicap!), confirmed_at: t,
          });
          s.teamScores.push({ event_id: eventId, team_id: team.id, hole_scores: Array(9).fill(null), status: 'pending', updated_at: t });
        }
      }
      ev.status = 'locked';
      ev.locked_at = t;
    });
  }

  async unlockEvent(eventId: string) {
    this.mutate((s) => {
      const ev = s.events.find((e) => e.id === eventId)!;
      if (ev.status !== 'locked') throw new RuleError('Only a locked event can be unlocked.');
      const ids = new Set(s.assignments.filter((a) => a.event_id === eventId).map((a) => a.id));
      const mine = [...s.scores.filter((r) => ids.has(r.assignment_id)), ...s.teamScores.filter((r) => r.event_id === eventId)];
      if (mine.some((r) => r.status !== 'pending' || r.hole_scores.some((h) => h != null))) {
        throw new RuleError('Scores have been entered, so the setup and handicaps stay locked.');
      }
      s.scores = s.scores.filter((r) => !ids.has(r.assignment_id));
      s.teamScores = s.teamScores.filter((r) => r.event_id !== eventId);
      s.eventTeams = s.eventTeams.filter((r) => r.event_id !== eventId);
      for (const a of s.assignments.filter((x) => x.event_id === eventId)) {
        a.index_used = a.course_handicap = a.strokes = null;
        a.handicap_confirmed_at = null;
      }
      for (const ss of s.sessions.filter((x) => x.event_id === eventId)) {
        ss.status = 'scheduled';
        ss.resolved_at = null;
      }
      ev.status = 'draft';
      ev.locked_at = null;
    });
  }

  async saveScore(assignmentId: string, holes: (number | null)[], status: ResultStatus) {
    this.mutate((s) => {
      const a = s.assignments.find((x) => x.id === assignmentId);
      if (!a) throw new Error('Assignment not found.');
      const ev = s.events.find((e) => e.id === a.event_id)!;
      const sess = s.sessions.find((x) => x.id === a.session_id)!;
      if (ev.status === 'draft') throw new RuleError('Lock the event and confirm handicaps before entering scores.');
      if (ev.status === 'published') throw new RuleError('Results are published. Unpublish the event to correct a score.');
      if (sess.status === 'resolved') throw new RuleError(`Day ${sess.session_number} is marked complete. Reopen it to change a score.`);
      checkScoreEntry(holes, status);
      const row = s.scores.find((r) => r.assignment_id === assignmentId);
      if (row) Object.assign(row, { hole_scores: holes, status, updated_at: now() });
      else s.scores.push({ assignment_id: assignmentId, hole_scores: holes, status, updated_at: now() });
    });
  }

  async resolveSession(sessionId: string) {
    this.mutate((s) => {
      const sess = s.sessions.find((x) => x.id === sessionId)!;
      const ev = s.events.find((e) => e.id === sess.event_id)!;
      if (ev.status !== 'locked') throw new RuleError('Lock the event before completing a day.');
      if (ev.format === 'scramble') {
        const waitingTeams = s.eventTeams
          .filter((x) => x.session_id === sessionId)
          .filter((x) => (s.teamScores.find((r) => r.event_id === x.event_id && r.team_id === x.team_id)?.status ?? 'pending') === 'pending')
          .map((x) => teamName(s.teams.find((t) => t.id === x.team_id)!));
        if (waitingTeams.length) {
          throw new RuleError(`Still waiting on: ${waitingTeams.join(', ')}. Mark each team completed, did not finish, or did not attend.`);
        }
        sess.status = 'resolved';
        sess.resolved_at = now();
        return;
      }
      const waiting = s.assignments
        .filter((a) => a.session_id === sessionId)
        .filter((a) => (s.scores.find((r) => r.assignment_id === a.id)?.status ?? 'pending') === 'pending')
        .map((a) => s.players.find((p) => p.id === a.player_id)?.name);
      if (waiting.length) {
        throw new RuleError(`Still waiting on: ${waiting.join(', ')}. Mark each player completed, did not finish, or did not attend.`);
      }
      sess.status = 'resolved';
      sess.resolved_at = now();
    });
  }

  async reopenSession(sessionId: string) {
    this.mutate((s) => {
      const sess = s.sessions.find((x) => x.id === sessionId)!;
      const ev = s.events.find((e) => e.id === sess.event_id)!;
      if (ev.status === 'published') throw new RuleError('Unpublish the results before reopening a day.');
      sess.status = 'scheduled';
      sess.resolved_at = null;
    });
  }

  async publishEvent(eventId: string) {
    this.mutate((s) => {
      const ev = s.events.find((e) => e.id === eventId)!;
      if (ev.status !== 'locked') throw new RuleError('Only a locked event can be published.');
      if (s.sessions.some((x) => x.event_id === eventId && x.status !== 'resolved')) {
        throw new RuleError('Complete every scheduled day before publishing.');
      }
      s.results = s.results.filter((r) => r.event_id !== eventId);
      if (ev.format === 'scramble') {
        const lb = buildTeamLeaderboard(teamEntriesFor(s, eventId), s.settings.field_size_basis);
        if (!lb.allResolved) throw new RuleError('Every team must be marked completed, did not finish, or did not attend.');
        if (!lb.lookup.ok) throw new RuleError(teamTableReason(lb.field));
        for (const r of lb.rows) {
          const et = s.eventTeams.find((x) => x.event_id === eventId && x.team_id === r.player_id)!;
          for (const pid of [et.player_a, et.player_b]) {
            s.results.push({
              event_id: eventId, player_id: pid, team_id: et.team_id, session_number: r.session_number,
              status: r.status as EventResult['status'], position: r.position, tied: r.tied,
              gross: r.status === 'dna' ? null : r.gross, strokes: r.strokes, net: r.net, points: r.points,
            });
          }
        }
        ev.status = 'published';
        ev.published_at = now();
        return;
      }
      const lb = buildLeaderboard(entriesFor(s, eventId), s.settings.field_size_basis);
      if (!lb.allResolved) throw new RuleError('Every player must be marked completed, did not finish, or did not attend.');
      if (!lb.lookup.ok) throw new RuleError(lb.lookup.reason);
      for (const r of lb.rows) {
        s.results.push({
          event_id: eventId,
          player_id: r.player_id,
          team_id: null,
          session_number: r.session_number,
          status: r.status as EventResult['status'],
          position: r.position,
          tied: r.tied,
          gross: r.status === 'dna' ? null : r.gross,
          strokes: r.strokes,
          net: r.net,
          points: r.points,
        });
      }
      ev.status = 'published';
      ev.published_at = now();
    });
  }

  async unpublishEvent(eventId: string) {
    this.mutate((s) => {
      const ev = s.events.find((e) => e.id === eventId)!;
      if (ev.status !== 'published') throw new RuleError('This event is not published.');
      s.results = s.results.filter((r) => r.event_id !== eventId);
      ev.status = 'locked';
      ev.published_at = null;
    });
  }
}

/** Leaderboard input for an event from whatever scores the viewer can see. */
export function entriesFor(s: Snapshot, eventId: string) {
  return s.assignments
    .filter((a) => a.event_id === eventId)
    .map((a) => {
      const sc = s.scores.find((r) => r.assignment_id === a.id);
      const sess = s.sessions.find((x) => x.id === a.session_id);
      return {
        player_id: a.player_id,
        session_number: sess?.session_number ?? 1,
        status: sc?.status ?? ('pending' as ResultStatus),
        hole_scores: sc?.hole_scores ?? Array(9).fill(null),
        strokes: a.strokes,
      };
    });
}

/** Scramble leaderboard input: one entry per team. */
export function teamEntriesFor(s: Snapshot, eventId: string) {
  return s.eventTeams
    .filter((x) => x.event_id === eventId)
    .map((x) => {
      const sc = s.teamScores.find((r) => r.event_id === eventId && r.team_id === x.team_id);
      const sess = s.sessions.find((y) => y.id === x.session_id);
      return {
        team_id: x.team_id,
        session_number: sess?.session_number ?? 1,
        status: sc?.status ?? ('pending' as ResultStatus),
        hole_scores: sc?.hole_scores ?? Array(9).fill(null),
        strokes: x.strokes,
      };
    });
}

export const teamTableReason = (n: number) =>
  `No approved points table for a ${n}-team scramble. The rules only define 4- and 8-entry tables, so the commissioner must resolve this before publishing.`;
