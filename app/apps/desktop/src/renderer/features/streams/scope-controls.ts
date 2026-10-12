/**
 * The front-panel arithmetic of the monitor's oscilloscope: time/div and volts/div in 1-2-5 steps,
 * ten horizontal and eight vertical divisions, and autoset (fit what is on screen).
 */

/** Horizontal divisions of the graticule: the view spans ten time/div. */
export const TIME_DIVISIONS = 10;
/** Vertical divisions: the value axis spans eight volts/div around the centre. */
const VALUE_DIVISIONS = 8;

/** Time/div settings in ms. The shortest is the live feed's 100 ms minimum window over ten divisions. */
export const TIME_DIVS = [10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 60_000] as const;
export const DEFAULT_TIME_DIV = 1_000;

/** Volts/div (or units/div) settings, 1-2-5 from 100 µ to 100. */
export const VALUE_DIVS: readonly number[] = [-4, -3, -2, -1, 0, 1, 2].flatMap((exponent) =>
  [1, 2, 5].map((mantissa) => Number((mantissa * 10 ** exponent).toPrecision(3))));

/** The setting `steps` places away from `value` (the nearest setting when `value` is not one). */
export function stepSetting(settings: readonly number[], value: number, steps: number): number {
  let index = 0;
  settings.forEach((setting, at) => {
    if (Math.abs(Math.log(setting / value)) < Math.abs(Math.log((settings[index] ?? 1) / value))) index = at;
  });
  const next = Math.min(settings.length - 1, Math.max(0, index + steps));
  return settings[next] ?? value;
}

/** `1 s/div`, `200 ms/div`. */
export function timeDivText(ms: number): string {
  return ms >= 1_000 ? `${trim(ms / 1_000)} s/div` : `${trim(ms)} ms/div`;
}

/** `5 V/div`, `200 mV/div`; `2/div` without a unit. */
export function valueDivText(perDiv: number, unit: string): string {
  if (!unit) return `${trim(perDiv)}/div`;
  return perDiv < 1 ? `${trim(perDiv * 1_000)} m${unit}/div` : `${trim(perDiv)} ${unit}/div`;
}

function trim(value: number): string {
  return String(Number(value.toPrecision(3)));
}

/** A manual vertical setting: `perDiv` units per division, the screen centred on `center`. */
export interface VerticalScale {
  perDiv: number;
  center: number;
}

/** The value axis of a manual setting: four divisions either side of the centre. */
export function verticalRange({ perDiv, center }: VerticalScale): [number, number] {
  const half = (VALUE_DIVISIONS / 2) * perDiv;
  return [center - half, center + half];
}

/**
 * Autoset: the smallest volts/div that shows `[min, max]` within six of the eight divisions,
 * centred on the data rounded to a whole division, so grid lines fall on round values.
 */
export function autoset(min: number, max: number): VerticalScale {
  const span = Math.max(max - min, Math.abs(max) * 1e-3, 1e-4);
  const perDiv = VALUE_DIVS.find((setting) => setting * (VALUE_DIVISIONS - 2) >= span)
    ?? VALUE_DIVS[VALUE_DIVS.length - 1] ?? 1;
  const center = Math.round((min + max) / 2 / perDiv) * perDiv;
  return { perDiv, center: Number(center.toPrecision(12)) + 0 };
}

/** A grid label: as many decimals as the grid step needs, no more. */
export function tickText(value: number, step: number): string {
  let digits = 0;
  while (digits < 12 && step > 0 && Math.abs(Math.round(step * 10 ** digits) - step * 10 ** digits) > 1e-6) digits += 1;
  return String(Number(value.toFixed(step > 0 ? digits : 3)) + 0);
}

/** Grid lines of a manual vertical setting: one per division from bottom to top. */
export function divisionSplits(scale: VerticalScale): number[] {
  const [low] = verticalRange(scale);
  return Array.from({ length: VALUE_DIVISIONS + 1 }, (_, index) => low + index * scale.perDiv);
}
