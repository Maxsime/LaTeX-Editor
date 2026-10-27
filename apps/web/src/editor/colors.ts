/** An RGB colour, each channel from 0 to 1. */
export type Rgb = readonly [number, number, number];

/** A colour argument of the source and the colour it stands for. */
export interface ColorSwatch {
  /** Offset just after the argument, where the swatch is drawn. */
  at: number;
  color: Rgb;
}

/** Colours xcolor defines without options. */
const BASE_COLORS: Readonly<Record<string, Rgb>> = {
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  cyan: [0, 1, 1],
  magenta: [1, 0, 1],
  yellow: [1, 1, 0],
  black: [0, 0, 0],
  white: [1, 1, 1],
  gray: [0.5, 0.5, 0.5],
  darkgray: [0.25, 0.25, 0.25],
  lightgray: [0.75, 0.75, 0.75],
  brown: [0.75, 0.5, 0.25],
  lime: [0.75, 1, 0],
  olive: [0.5, 0.5, 0],
  orange: [1, 0.5, 0],
  pink: [1, 0.75, 0.75],
  purple: [0.75, 0, 0.25],
  teal: [0, 0.5, 0.5],
  violet: [0.5, 0, 0.5],
};

/** Commands whose first argument (after an optional model) is a colour. */
const COLOR_COMMANDS = new Set([
  'color',
  'textcolor',
  'colorbox',
  'fcolorbox',
  'pagecolor',
  'rowcolor',
  'cellcolor',
  'columncolor',
]);

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);

/** Reads a colour given in an xcolor model, or null for a model or value not understood. */
export function parseModel(model: string, spec: string): Rgb | null {
  if (model.trim() === 'HTML') {
    const hex = /^[0-9a-fA-F]{6}$/.exec(spec.trim())?.[0];
    if (hex === undefined) return null;
    const channel = (index: number) => Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return [channel(0), channel(2), channel(4)];
  }
  const values = spec
    .split(/\s*,\s*|\s+/)
    .filter(Boolean)
    .map(Number);
  if (values.length === 0 || values.some((value) => Number.isNaN(value))) return null;
  const [a = 0, b = 0, c = 0, d = 0] = values;
  switch (model.trim()) {
    case 'rgb':
      return values.length === 3 ? [clamp(a), clamp(b), clamp(c)] : null;
    case 'RGB':
      return values.length === 3 ? [clamp(a / 255), clamp(b / 255), clamp(c / 255)] : null;
    case 'gray':
      return values.length === 1 ? [clamp(a), clamp(a), clamp(a)] : null;
    case 'cmyk':
      return values.length === 4
        ? [clamp((1 - a) * (1 - d)), clamp((1 - b) * (1 - d)), clamp((1 - c) * (1 - d))]
        : null;
    default:
      return null;
  }
}

/**
 * Evaluates an xcolor expression such as `blue`, `red!30` (30 % red, the rest
 * white) or `red!30!blue`, against known colours.
 */
export function evaluateColor(expression: string, known: ReadonlyMap<string, Rgb>): Rgb | null {
  const parts = expression.trim().split('!');
  const lookup = (name: string): Rgb | null =>
    known.get(name.trim()) ?? BASE_COLORS[name.trim()] ?? null;
  let color = lookup(parts[0] ?? '');
  for (let index = 1; color !== null && index < parts.length; index += 2) {
    const percent = Number(parts[index]);
    if (Number.isNaN(percent)) return null;
    const other = index + 1 < parts.length ? lookup(parts[index + 1] ?? '') : BASE_COLORS.white;
    if (other === null || other === undefined) return null;
    const weight = clamp(percent / 100);
    const current = color;
    const mix = (channel: 0 | 1 | 2) => weight * current[channel] + (1 - weight) * other[channel];
    color = [mix(0), mix(1), mix(2)];
  }
  return color;
}

/** CSS form of a colour. */
export function cssColor(color: Rgb): string {
  const [r, g, b] = color.map((channel) => Math.round(channel * 255));
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}

const GROUP = String.raw`\{([^{}]*)\}`;
const DEFINITION = new RegExp(
  String.raw`\\(definecolor|providecolor)\s*${GROUP}\s*${GROUP}\s*${GROUP}`,
  'g',
);
const COLORLET = new RegExp(String.raw`\\colorlet\s*${GROUP}\s*${GROUP}`, 'g');
const USE = new RegExp(String.raw`\\([a-z]+)\s*(?:\[([^\]]*)\])?\s*${GROUP}`, 'g');

/** Strips comments, keeping offsets: each comment becomes spaces. */
function withoutComments(text: string): string {
  return text.replace(
    /(^|[^\\])%[^\n]*/g,
    (match, before: string) => before + ' '.repeat(match.length - before.length),
  );
}

/**
 * Colours of a file: the definitions it makes, and every use of a colour it
 * or xcolor defines, each with where to draw its swatch.
 */
export function colorSwatches(source: string): ColorSwatch[] {
  const text = withoutComments(source);
  const known = new Map<string, Rgb>();
  const swatches: ColorSwatch[] = [];
  for (const match of text.matchAll(DEFINITION)) {
    const color = parseModel(match[3] ?? '', match[4] ?? '');
    if (color === null) continue;
    known.set((match[2] ?? '').trim(), color);
    swatches.push({ at: match.index + match[0].length, color });
  }
  for (const match of text.matchAll(COLORLET)) {
    const color = evaluateColor(match[2] ?? '', known);
    if (color === null) continue;
    known.set((match[1] ?? '').trim(), color);
    swatches.push({ at: match.index + match[0].length, color });
  }
  for (const match of text.matchAll(USE)) {
    if (!COLOR_COMMANDS.has(match[1] ?? '')) continue;
    const model = match[2];
    const value = match[3] ?? '';
    const color = model === undefined ? evaluateColor(value, known) : parseModel(model, value);
    if (color !== null) swatches.push({ at: match.index + match[0].length, color });
  }
  return swatches.sort((a, b) => a.at - b.at);
}
