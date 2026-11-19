// Shared data shapes. These mirror the Supabase tables in supabase/migrations.

export type FieldSizeBasis = 'starters' | 'finishers';

export interface LeagueSettings {
  league_name: string;
  season_year: number;
  /** Commissioner-approved rule: does field size count everyone who teed off, or only 9-hole finishers? */
  field_size_basis: FieldSizeBasis;
  time_zone: string; // always America/Chicago for this league
  /** Match play points per player; null until the commissioner sets them. */
  match_win_points: number | null;
  match_halve_points: number | null;
}

export type HandicapSource = 'ghin' | 'manual';

export interface Player {
  id: string;
  name: string;
  ghin_number: string | null;
  handicap_index: number | null;
  handicap_source: HandicapSource;
  active: boolean;
}

export type EventStatus = 'draft' | 'locked' | 'published';

export interface SimSettings {
  green_speed: string;
  fairway_firmness: string;
  wind: string;
  putting: string;
  mulligans: string;
}

export type EventFormat = 'individual' | 'scramble' | 'alt_shot' | 'shamble' | 'best_ball' | 'match_play';
export type MatchType = 'singles' | 'fourball';

export interface LeagueEvent {
  id: string;
  format: EventFormat;
  /** Team formats: 2 (season teams) or 4 (each session's group is a team). */
  team_size: 2 | 4;
  /** Best ball / shamble: how many net scores count on each hole. */
  counting_scores: number;
  /** Match play: 1 vs 1, or 2 vs 2 best ball with season teams. */
  match_type: MatchType;
  /** Stroke index from the course card (1–18) for holes 1–9; needed when strokes fall hole by hole. */
  hole_si: (number | null)[] | null;
  season_year: number;
  event_number: number; // 1..5
  name: string;
  course_name: string;
  tees: string;
  par9: number | null;
  course_rating9: number | null;
  slope9: number | null;
  sim_settings: SimSettings;
  status: EventStatus;
  locked_at: string | null;
  published_at: string | null;
}

export type SessionStatus = 'scheduled' | 'resolved';

export interface EventSession {
  id: string;
  event_id: string;
  session_number: 1 | 2;
  /** Calendar date in the league time zone (America/Chicago), YYYY-MM-DD */
  session_date: string;
  /** Local start time in the league time zone, HH:MM */
  start_time: string;
  status: SessionStatus;
  resolved_at: string | null;
}

export interface SessionAssignment {
  id: string;
  event_id: string;
  session_id: string;
  player_id: string;
  // Handicap snapshot, filled in when the event is locked.
  index_used: number | null;
  course_handicap: number | null; // unrounded 9-hole course handicap
  strokes: number | null; // 80% allowance, rounded
  handicap_confirmed_at: string | null;
  /** Match play singles: players with the same slot in a session play each other. */
  match_slot: 1 | 2 | null;
}

export type ResultStatus = 'pending' | 'completed' | 'dnf' | 'dna';

/** Private until the event is published. */
export interface RoundScore {
  assignment_id: string;
  hole_scores: (number | null)[]; // length 9
  status: ResultStatus;
  updated_at: string;
}

export interface EventResult {
  event_id: string;
  player_id: string;
  /** Season team, when the player's entry was one. */
  team_id: string | null;
  /** The team / match entry this result came from (team and match formats). */
  entry_id: string | null;
  /** Match play: e.g. "Won 2 up vs Austin". */
  detail: string | null;
  session_number: number;
  status: Exclude<ResultStatus, 'pending'>;
  position: number | null;
  tied: boolean;
  gross: number | null;
  strokes: number | null;
  net: number | null;
  points: number;
}

/** Fixed 2-person scramble team for a season. */
export interface Team {
  id: string;
  season_year: number;
  name: string;
  player_a: string;
  player_b: string;
}

/**
 * One competitor in a team or match event, created when the event is locked:
 * a season team, a 4-person session group, or (match play singles) one player.
 */
export interface EventEntry {
  id: string;
  event_id: string;
  session_id: string;
  team_id: string | null; // season team, when the entry is one
  match_slot: 1 | 2 | null;
  /** Team strokes for one-card formats (scramble, alternate shot). */
  strokes: number | null;
  confirmed_at: string;
}

export interface EntryMember {
  entry_id: string;
  player_id: string;
  course_handicap: number; // unrounded 9-hole course handicap
  /** Per-hole formats: strokes this player receives over 9 holes (match play: off the low player). */
  playing_handicap: number | null;
}

/** One card per team for scramble / alternate shot. Private until published. */
export interface EntryScore {
  entry_id: string;
  hole_scores: (number | null)[];
  status: ResultStatus;
  updated_at: string;
}

export interface Snapshot {
  settings: LeagueSettings;
  players: Player[];
  events: LeagueEvent[];
  sessions: EventSession[];
  assignments: SessionAssignment[];
  /** Only the rows the current viewer may see (commissioner, or published events). */
  scores: RoundScore[];
  results: EventResult[];
  teams: Team[];
  entries: EventEntry[];
  entryMembers: EntryMember[];
  /** Only the rows the current viewer may see. */
  entryScores: EntryScore[];
}
