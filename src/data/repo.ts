import type { LeagueEvent, LeagueSettings, Player, ResultStatus, SimSettings, Snapshot } from '../lib/types';

export type EventSetupPatch = Partial<
  Pick<LeagueEvent, 'name' | 'course_name' | 'tees' | 'par9' | 'course_rating9' | 'slope9'> & { sim_settings: SimSettings }
>;

export type PlayerInput = Omit<Player, 'id'> & { id?: string };

/** Everything the UI needs from storage. Implemented by Supabase (production) and a local demo store. */
export interface Repo {
  readonly mode: 'supabase' | 'demo';
  load(): Promise<Snapshot>;
  currentUser(): Promise<{ email: string } | null>;
  isCommissioner(): Promise<boolean>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;

  updateSettings(patch: Partial<Pick<LeagueSettings, 'league_name' | 'field_size_basis'>>): Promise<void>;
  savePlayer(p: PlayerInput): Promise<void>;

  updateEvent(eventId: string, patch: EventSetupPatch): Promise<void>;
  saveSession(eventId: string, sessionNumber: 1 | 2, date: string, startTime: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  assign(eventId: string, sessionId: string, playerId: string): Promise<void>;
  moveAssignment(assignmentId: string, sessionId: string): Promise<void>;
  unassign(assignmentId: string): Promise<void>;

  lockEvent(eventId: string): Promise<void>;
  unlockEvent(eventId: string): Promise<void>;
  saveScore(assignmentId: string, holes: (number | null)[], status: ResultStatus): Promise<void>;
  resolveSession(sessionId: string): Promise<void>;
  reopenSession(sessionId: string): Promise<void>;
  publishEvent(eventId: string): Promise<void>;
  unpublishEvent(eventId: string): Promise<void>;
}

export function checkScoreEntry(holes: (number | null)[], status: ResultStatus): void {
  if (holes.length !== 9) throw new Error('A round has 9 holes.');
  for (const h of holes) if (h != null && (!Number.isInteger(h) || h < 1 || h > 20)) throw new Error('Hole scores must be 1–20 strokes.');
  const played = holes.filter((h) => h != null).length;
  if (status === 'completed' && played !== 9) throw new Error('A player must finish all 9 holes to be marked completed.');
  if (status === 'dna' && played > 0) throw new Error("A player who did not attend can't have hole scores.");
}
