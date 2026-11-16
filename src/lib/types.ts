// Shared data shapes. These mirror the Supabase tables in supabase/migrations.

export type FieldSizeBasis = 'starters' | 'finishers';

export interface LeagueSettings {
  league_name: string;
  season_year: number;
  /** Commissioner-approved rule: does field size count everyone who teed off, or only 9-hole finishers? */
  field_size_basis: FieldSizeBasis;
  time_zone: string; // always America/Chicago for this league
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

export interface LeagueEvent {
  id: string;
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
  session_number: number;
  status: Exclude<ResultStatus, 'pending'>;
  position: number | null;
  tied: boolean;
  gross: number | null;
  strokes: number | null;
  net: number | null;
  points: number;
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
}
