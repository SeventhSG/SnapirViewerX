/**
 * Units.
 *
 * A PLY file carries no unit. Nothing in the format says whether a coordinate
 * of 1.0 means a metre, a millimetre or an inch, and no scanning app writes it
 * down anywhere the format can hold. So the app keeps two separate numbers and
 * never confuses them:
 *
 *   - the SOURCE unit, what one unit in the file means. A property of the
 *     scan. Wrong here and every measurement is wrong by a fixed factor.
 *   - the DISPLAY unit, what the operator wants to read. A preference. Changing
 *     it changes no geometry at all.
 *
 * Everything between the parser and the screen is held in metres.
 */

export type Unit = "mm" | "cm" | "m" | "in" | "ft";

/** Metres per one of this unit. Exact by definition for the imperial pair:
 *  the inch has been exactly 25.4 mm since 1959. */
const METRES: Record<Unit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

export const UNITS: Unit[] = ["mm", "cm", "m", "in", "ft"];

export const UNIT_LABEL: Record<Unit, string> = {
  mm: "mm",
  cm: "cm",
  m: "m",
  in: "in",
  ft: "ft",
};

/** How many of `unit` one metre is. */
export function fromMetres(metres: number, unit: Unit): number {
  return metres / METRES[unit];
}

/** Metres, from a number already in `unit`. */
export function toMetres(value: number, unit: Unit): number {
  return value * METRES[unit];
}

/** The factor that turns a raw file coordinate into metres. */
export function sourceScale(unit: Unit): number {
  return METRES[unit];
}

/**
 * Decimals worth showing for a unit. A millimetre reading with three decimals
 * claims a precision no phone LiDAR has; a metre reading with none is useless.
 * These are chosen so every unit resolves to roughly a tenth of a millimetre,
 * which is already finer than the instrument.
 */
const PLACES: Record<Unit, number> = { mm: 1, cm: 2, m: 4, in: 3, ft: 4 };

/** A length in metres, written in the display unit, without the unit on it. */
export function formatLength(metres: number, unit: Unit): string {
  const v = fromMetres(metres, unit);
  return v.toFixed(PLACES[unit]);
}

/** The same, with the unit. What goes on a measurement label. */
export function formatWithUnit(metres: number, unit: Unit): string {
  return `${formatLength(metres, unit)} ${UNIT_LABEL[unit]}`;
}

/**
 * A guess at the source unit from the size of the scan, offered as a default
 * and never applied silently.
 *
 * iOS depth APIs report metres, and every iPhone and iPad scanning app the
 * viewer targets writes metres straight out. So the guess is right almost
 * always, and the two cases it catches are a file that has already been scaled
 * somewhere else. A room is somewhere between 1 and 30 units across in metres,
 * a thousand times that in millimetres.
 */
export function guessSourceUnit(diagonal: number): Unit {
  if (diagonal > 3000) return "mm";
  if (diagonal > 300) return "cm";
  return "m";
}
