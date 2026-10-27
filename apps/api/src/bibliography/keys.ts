/** What a citation key is built from. */
export interface KeySource {
  /** Family names of the authors, or of the editors when there are none. */
  names: string[];
  title: string | null;
  year: string | null;
}

/** Words skipped by `[shorttitle]` and `[title3]`, in French and English. */
const STOP_WORDS = new Set(
  (
    'a an the of on in at to for from by with and or but as is are be into onto about over under ' +
    'via its this that these those how what why when which who towards toward using ' +
    'le la les l un une des du de d au aux et ou en dans sur pour par avec sans sous vers ' +
    'ce cette ces son sa ses leur leurs qui que quoi dont est sont'
  ).split(' '),
);

/** Folds accents and ligatures to ASCII letters and drops everything else but letters and digits. */
export function asciiFold(value: string): string {
  return value
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, (char) => (char === 'æ' ? 'ae' : 'AE'))
    .replace(/[œŒ]/g, (char) => (char === 'œ' ? 'oe' : 'OE'))
    .replace(/[øØ]/g, (char) => (char === 'ø' ? 'o' : 'O'))
    .replace(/[łŁ]/g, (char) => (char === 'ł' ? 'l' : 'L'))
    .normalize('NFD')
    .replace(/[^A-Za-z0-9]/g, '');
}

function titleWords(title: string | null): string[] {
  if (title === null) return [];
  return title
    .split(/[\s\-–—:;,.!?/()[\]{}"'’«»]+/)
    .map(asciiFold)
    .filter((word) => word !== '' && !STOP_WORDS.has(word.toLowerCase()));
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Names of the tokens a key pattern may use. */
export const KEY_TOKENS = ['auth', 'authors2', 'year', 'shorttitle', 'title3'] as const;

function tokenValue(token: string, source: KeySource): string | null {
  const names = source.names.map(asciiFold).filter((name) => name !== '');
  switch (token) {
    case 'auth':
      return names[0] ?? titleWords(source.title)[0] ?? '';
    case 'authors2':
      if (names.length > 2) return `${names[0] ?? ''}EtAl`;
      return names.join('');
    case 'year':
      return /\d{4}/.exec(source.year ?? '')?.[0] ?? '';
    case 'shorttitle':
      return titleWords(source.title)[0] ?? '';
    case 'title3':
      return titleWords(source.title).slice(0, 3).map(capitalise).join('');
    default:
      return null;
  }
}

/** Tokens of `pattern` that are not known, for validating a project setting. */
export function unknownKeyTokens(pattern: string): string[] {
  const unknown: string[] = [];
  for (const match of pattern.matchAll(/\[([^\]:]*)((?::[^\]:]*)*)\]/g)) {
    const name = match[1] ?? '';
    const modifiers = (match[2] ?? '').split(':').filter((modifier) => modifier !== '');
    if (!(KEY_TOKENS as readonly string[]).includes(name)) unknown.push(name);
    for (const modifier of modifiers) {
      if (modifier !== 'lower' && modifier !== 'upper') unknown.push(`${name}:${modifier}`);
    }
  }
  return unknown;
}

/**
 * Builds a citation key from `pattern`: `[token]` or `[token:lower]` fields
 * and literal characters, e.g. `[auth:lower][year][shorttitle:lower]` gives
 * `knuth1984literate`. The result holds ASCII letters, digits and `_:.-`.
 */
export function buildKey(pattern: string, source: KeySource): string {
  const key = pattern.replace(
    /\[([^\]:]*)((?::[^\]:]*)*)\]/g,
    (_whole, name: string, mods: string) => {
      let value = tokenValue(name, source) ?? '';
      for (const modifier of mods.split(':')) {
        if (modifier === 'lower') value = value.toLowerCase();
        else if (modifier === 'upper') value = value.toUpperCase();
      }
      return value;
    },
  );
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, '');
  return /[A-Za-z0-9]/.test(safe) ? safe : 'ref';
}

/**
 * Returns `key`, or `key` followed by the first free suffix `a`, `b`… `z`,
 * `aa`… when it is already taken. Comparison ignores case, as BibTeX does.
 */
export function freeKey(key: string, taken: Set<string>): string {
  const lower = (value: string) => value.toLowerCase();
  let candidate = key;
  for (let index = 0; taken.has(lower(candidate)); index += 1) {
    let suffix = '';
    let rest = index;
    do {
      suffix = String.fromCharCode(97 + (rest % 26)) + suffix;
      rest = Math.floor(rest / 26) - 1;
    } while (rest >= 0);
    candidate = key + suffix;
  }
  taken.add(lower(candidate));
  return candidate;
}
