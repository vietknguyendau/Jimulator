import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { checkAssignment, checkSessionDate, checkStartTime } from '../lib/schedule';
import type {
  EventResult, EventSession, LeagueEvent, LeagueSettings, Player, ResultStatus, RoundScore, SessionAssignment, Snapshot,
} from '../lib/types';
import { checkScoreEntry, type EventSetupPatch, type PlayerInput, type Repo } from './repo';

const num = (x: unknown) => (x == null ? null : Number(x));

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export class SupabaseRepo implements Repo {
  readonly mode = 'supabase' as const;
  private sb: SupabaseClient;
  private cache: Snapshot | null = null;

  constructor(url: string, anonKey: string) {
    // Session persists in localStorage, so a signed-out commissioner signs back in to the same saved scores.
    this.sb = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  }

  async load(): Promise<Snapshot> {
    const [settings, players, events, sessions, assignments, scores, results] = await Promise.all([
      this.sb.from('league_settings').select('*').eq('id', 1).single(),
      this.sb.from('players').select('*').order('name'),
      this.sb.from('events').select('*').order('season_year').order('event_number'),
      this.sb.from('event_sessions').select('*').order('session_number'),
      this.sb.from('session_assignments').select('*'),
      this.sb.from('round_scores').select('*'), // RLS: commissioner, or published events only
      this.sb.from('event_results').select('*'),
    ]);
    const st = unwrap(settings) as LeagueSettings;
    const snap: Snapshot = {
      settings: { league_name: st.league_name, season_year: st.season_year, field_size_basis: st.field_size_basis, time_zone: st.time_zone },
      players: unwrap(players).map((p: Player) => ({ ...p, handicap_index: num(p.handicap_index) })),
      events: unwrap(events).map((e: LeagueEvent) => ({ ...e, course_rating9: num(e.course_rating9) })),
      sessions: unwrap(sessions).map((s: EventSession) => ({ ...s, start_time: String(s.start_time).slice(0, 5) })),
      assignments: unwrap(assignments).map((a: SessionAssignment) => ({
        ...a, index_used: num(a.index_used), course_handicap: num(a.course_handicap),
      })),
      scores: unwrap(scores) as RoundScore[],
      results: unwrap(results).map((r: EventResult) => ({ ...r, points: Number(r.points) })),
    };
    this.cache = snap;
    return snap;
  }

  private async snap() {
    return this.cache ?? this.load();
  }

  async currentUser() {
    const { data } = await this.sb.auth.getSession();
    return data.session?.user.email ? { email: data.session.user.email } : null;
  }
  async isCommissioner() {
    const { data } = await this.sb.auth.getSession();
    if (!data.session) return false;
    const r = await this.sb.rpc('is_commissioner');
    return r.data === true;
  }
  async signIn(email: string, password: string) {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
    if (!(await this.isCommissioner())) {
      await this.sb.auth.signOut();
      throw new Error('That account is not the league commissioner.');
    }
  }
  async signOut() {
    await this.sb.auth.signOut();
  }

  async updateSettings(patch: Parameters<Repo['updateSettings']>[0]) {
    unwrap(await this.sb.from('league_settings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1));
  }

  async savePlayer(p: PlayerInput) {
    const { id, ...rest } = p;
    if (id) unwrap(await this.sb.from('players').update(rest).eq('id', id));
    else unwrap(await this.sb.from('players').insert(rest));
  }

  async updateEvent(eventId: string, patch: EventSetupPatch) {
    unwrap(await this.sb.from('events').update(patch).eq('id', eventId));
  }

  async saveSession(eventId: string, n: 1 | 2, date: string, startTime: string) {
    const s = await this.snap();
    checkStartTime(startTime);
    checkSessionDate(s.sessions, eventId, n, date); // the database checks again
    const existing = s.sessions.find((x) => x.event_id === eventId && x.session_number === n);
    if (existing) {
      unwrap(await this.sb.from('event_sessions').update({ session_date: date, start_time: startTime }).eq('id', existing.id));
    } else {
      unwrap(await this.sb.from('event_sessions').insert({ event_id: eventId, session_number: n, session_date: date, start_time: startTime }));
    }
  }

  async deleteSession(sessionId: string) {
    unwrap(await this.sb.from('event_sessions').delete().eq('id', sessionId));
  }

  async assign(eventId: string, sessionId: string, playerId: string) {
    const s = await this.snap();
    checkAssignment(s.sessions, s.assignments, eventId, sessionId, playerId);
    unwrap(await this.sb.from('session_assignments').insert({ event_id: eventId, session_id: sessionId, player_id: playerId }));
  }

  async moveAssignment(assignmentId: string, sessionId: string) {
    unwrap(await this.sb.from('session_assignments').update({ session_id: sessionId }).eq('id', assignmentId));
  }

  async unassign(assignmentId: string) {
    unwrap(await this.sb.from('session_assignments').delete().eq('id', assignmentId));
  }

  private async rpc(fn: string, args: Record<string, unknown>) {
    const { error } = await this.sb.rpc(fn, args);
    if (error) throw new Error(error.message);
  }

  lockEvent = (id: string) => this.rpc('lock_event', { p_event: id });
  unlockEvent = (id: string) => this.rpc('unlock_event', { p_event: id });
  resolveSession = (id: string) => this.rpc('resolve_session', { p_session: id });
  reopenSession = (id: string) => this.rpc('reopen_session', { p_session: id });
  publishEvent = (id: string) => this.rpc('publish_event', { p_event: id });
  unpublishEvent = (id: string) => this.rpc('unpublish_event', { p_event: id });

  async saveScore(assignmentId: string, holes: (number | null)[], status: ResultStatus) {
    checkScoreEntry(holes, status);
    unwrap(await this.sb.from('round_scores').upsert({ assignment_id: assignmentId, hole_scores: holes, status }));
  }
}
