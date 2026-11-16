import type { FieldSizeBasis, ResultStatus } from './types';

/** Official points tables. Only 8- and 4-player fields have an approved table. */
export const POINTS_TABLES: Record<number, number[]> = {
  8: [16, 13, 11, 9, 7, 5, 3, 1],
  4: [12, 9, 6, 3],
};

export interface FieldCount {
  starters: number; // completed + did not finish (everyone who teed off)
  finishers: number; // completed all 9 holes
}

export function countField(statuses: ResultStatus[]): FieldCount {
  const finishers = statuses.filter((s) => s === 'completed').length;
  const dnf = statuses.filter((s) => s === 'dnf').length;
  return { starters: finishers + dnf, finishers };
}

export function fieldSize(statuses: ResultStatus[], basis: FieldSizeBasis): number {
  const c = countField(statuses);
  return basis === 'starters' ? c.starters : c.finishers;
}

export type TableLookup =
  | { ok: true; size: number; table: number[] }
  | { ok: false; size: number; reason: string };

/**
 * Unresolved policy: the rules define points only for 4- and 8-player fields.
 * Any other field size blocks publishing until the commissioner resolves it.
 */
export function pointsTableFor(size: number): TableLookup {
  const table = POINTS_TABLES[size];
  if (table) return { ok: true, size, table };
  return {
    ok: false,
    size,
    reason: `No approved points table for a ${size}-player field. The rules only define 4- and 8-player events, so the commissioner must resolve this before results can be published.`,
  };
}

/** Points for positions start..start+count-1 (1-based), averaged. Positions past the table earn 0. */
export function splitPoints(table: number[], start: number, count: number): number {
  let total = 0;
  for (let p = start; p < start + count; p++) total += table[p - 1] ?? 0;
  return Math.round((total / count) * 100) / 100;
}
