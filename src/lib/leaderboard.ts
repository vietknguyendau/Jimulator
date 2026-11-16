import { fieldSize, pointsTableFor, splitPoints, type TableLookup } from './points';
import type { FieldSizeBasis, ResultStatus } from './types';

export interface LeaderboardEntry {
  player_id: string;
  session_number: number;
  status: ResultStatus;
  hole_scores: (number | null)[];
  strokes: number | null;
}

export interface LeaderboardRow {
  player_id: string;
  session_number: number;
  status: ResultStatus;
  position: number | null;
  tied: boolean;
  gross: number | null;
  strokes: number | null;
  net: number | null;
  points: number;
  holes_played: number;
}

export interface Leaderboard {
  rows: LeaderboardRow[];
  field: number;
  lookup: TableLookup;
  /** True when every player has a final status (completed / dnf / dna). */
  allResolved: boolean;
}

export const holesPlayed = (h: (number | null)[]) => h.filter((x) => x != null && x > 0).length;
export const grossOf = (h: (number | null)[]) => h.reduce<number>((t, x) => t + (x ?? 0), 0);

/**
 * One combined leaderboard across both sessions. Lowest net wins; ties split the
 * points for the positions they occupy; the next player skips those positions.
 * Only 9-hole finishers earn points.
 */
export function buildLeaderboard(entries: LeaderboardEntry[], basis: FieldSizeBasis): Leaderboard {
  const statuses = entries.map((e) => e.status);
  const field = fieldSize(statuses, basis);
  const lookup = pointsTableFor(field);
  const table = lookup.ok ? lookup.table : [];

  const base = entries.map((e) => {
    const played = holesPlayed(e.hole_scores);
    const gross = played > 0 ? grossOf(e.hole_scores) : null;
    const net = e.status === 'completed' && gross != null && e.strokes != null ? gross - e.strokes : null;
    return { ...e, gross, net, holes_played: played };
  });

  const finishers = base.filter((e) => e.status === 'completed' && e.net != null).sort((a, b) => a.net! - b.net!);
  const rows: LeaderboardRow[] = [];
  let i = 0;
  while (i < finishers.length) {
    let j = i;
    while (j + 1 < finishers.length && finishers[j + 1].net === finishers[i].net) j++;
    const position = i + 1;
    const count = j - i + 1;
    const pts = lookup.ok ? splitPoints(table, position, count) : 0;
    for (let k = i; k <= j; k++) {
      const e = finishers[k];
      rows.push({
        player_id: e.player_id,
        session_number: e.session_number,
        status: e.status,
        position,
        tied: count > 1,
        gross: e.gross,
        strokes: e.strokes,
        net: e.net,
        points: pts,
        holes_played: e.holes_played,
      });
    }
    i = j + 1;
  }
  const order: ResultStatus[] = ['pending', 'dnf', 'dna'];
  for (const st of order) {
    for (const e of base.filter((x) => x.status === st)) {
      rows.push({
        player_id: e.player_id,
        session_number: e.session_number,
        status: e.status,
        position: null,
        tied: false,
        gross: e.gross,
        strokes: e.strokes,
        net: null,
        points: 0,
        holes_played: e.holes_played,
      });
    }
  }
  return { rows, field, lookup, allResolved: entries.length > 0 && entries.every((e) => e.status !== 'pending') };
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function formatPoints(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(2).replace(/0$/, '');
}
