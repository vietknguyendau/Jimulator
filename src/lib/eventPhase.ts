import type { EventSession, LeagueEvent } from './types';

export type EventPhase =
  | { kind: 'unscheduled'; label: 'Not scheduled' }
  | { kind: 'scheduled'; label: 'Scheduled' }
  | { kind: 'day2_pending'; label: 'Day 2 pending' }
  | { kind: 'awaiting_results'; label: 'Results pending' }
  | { kind: 'official'; label: 'Official results' };

/** Public-facing state of an event. Scores stay private in every phase except 'official'. */
export function eventPhase(event: LeagueEvent, sessions: EventSession[]): EventPhase {
  if (event.status === 'published') return { kind: 'official', label: 'Official results' };
  const ss = sessions.filter((s) => s.event_id === event.id).sort((a, b) => a.session_number - b.session_number);
  if (ss.length === 0) return { kind: 'unscheduled', label: 'Not scheduled' };
  const resolved = ss.filter((s) => s.status === 'resolved').length;
  if (ss.length === 2 && ss[0].status === 'resolved' && ss[1].status !== 'resolved') {
    return { kind: 'day2_pending', label: 'Day 2 pending' };
  }
  if (resolved === ss.length) return { kind: 'awaiting_results', label: 'Results pending' };
  return { kind: 'scheduled', label: 'Scheduled' };
}
