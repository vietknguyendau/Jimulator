export const HANDICAP_ALLOWANCE = 0.8;

export interface NineHoleRating {
  par9: number;
  course_rating9: number;
  slope9: number;
}

/**
 * WHS 9-hole Course Handicap:
 *   (Handicap Index ÷ 2) × (9-hole Slope ÷ 113) + (9-hole Course Rating − 9-hole Par)
 * Left unrounded; the league rounds once, after the 80% allowance.
 */
export function nineHoleCourseHandicap(index: number, r: NineHoleRating): number {
  return (index / 2) * (r.slope9 / 113) + (r.course_rating9 - r.par9);
}

/** Round to nearest whole number, halves up (toward +∞), immune to float noise. */
export function roundHalfUp(x: number): number {
  return Math.floor(Number(x.toFixed(6)) + 0.5);
}

export function strokesReceived(index: number, r: NineHoleRating): {
  courseHandicap: number;
  strokes: number;
} {
  const courseHandicap = nineHoleCourseHandicap(index, r);
  return { courseHandicap, strokes: roundHalfUp(courseHandicap * HANDICAP_ALLOWANCE) };
}

export function ratingComplete(e: {
  par9: number | null;
  course_rating9: number | null;
  slope9: number | null;
}): e is NineHoleRating {
  return e.par9 != null && e.course_rating9 != null && e.slope9 != null;
}

/** WHS recommended allowance for a 2-person scramble: 35% of the lower course handicap + 15% of the higher. */
export const SCRAMBLE_LOW = 0.35;
export const SCRAMBLE_HIGH = 0.15;

/** Team strokes from the two players' unrounded 9-hole course handicaps, rounded once like individual play. */
export function scrambleTeamStrokes(chA: number, chB: number): number {
  const low = Math.min(chA, chB);
  const high = Math.max(chA, chB);
  return roundHalfUp(low * SCRAMBLE_LOW + high * SCRAMBLE_HIGH);
}
