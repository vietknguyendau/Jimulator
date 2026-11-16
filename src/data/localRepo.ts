// Demo/offline store: same rules as the Supabase database, kept in browser storage.
// Used when no Supabase project is configured, and by the tests.
import { strokesReceived, ratingComplete } from '../lib/handicap';
import { buildLeaderboard } from '../lib/leaderboard';
import { checkAssignment, checkSessionDate, checkStartTime, lockProblems, MAX_PER_SESSION, MAX_PLAYERS, RuleError } from '../lib/schedule';
import type { EventResult, ResultStatus, Snapshot } from '../lib/types';
import { checkScoreEntry, type EventSetupPatch, type PlayerInput, type Repo } from './repo';

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
        return JSON.parse(raw) as Snapshot;
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

  async updateEvent(eventId: string, patch: EventSetupPatch) {
    this.mutate((s) => {
      const ev = s.events.find((e) => e.id === eventId);
      if (!ev) throw new Error('Event not found.');
      const setupKeys: (keyof EventSetupPatch)[] = ['course_name', 'tees', 'par9', 'course_rating9', 'slope9', 'sim_settings'];
      if (ev.status !== 'draft' && setupKeys.some((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(ev[k]))) {
        throw new RuleError("This event's setup is locked. Unlock it before changing the course, tees or simulator settings.");
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
      const problems = lockProblems(ev, s.sessions, s.assignments, s.players);
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
        if (!s.scores.some((r) => r.assignment_id === a.id)) {
          s.scores.push({ assignment_id: a.id, hole_scores: Array(9).fill(null), status: 'pending', updated_at: t });
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
      const mine = s.scores.filter((r) => ids.has(r.assignment_id));
      if (mine.some((r) => r.status !== 'pending' || r.hole_scores.some((h) => h != null))) {
        throw new RuleError('Scores have been entered, so the setup and handicaps stay locked.');
      }
      s.scores = s.scores.filter((r) => !ids.has(r.assignment_id));
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
      const lb = buildLeaderboard(entriesFor(s, eventId), s.settings.field_size_basis);
      if (!lb.allResolved) throw new RuleError('Every player must be marked completed, did not finish, or did not attend.');
      if (!lb.lookup.ok) throw new RuleError(lb.lookup.reason);
      s.results = s.results.filter((r) => r.event_id !== eventId);
      for (const r of lb.rows) {
        s.results.push({
          event_id: eventId,
          player_id: r.player_id,
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
