import { readGroup, scanCommands, skipOptionals } from './scanner.js';

/** Babel and polyglossia language names, as LanguageTool codes. */
const LANGUAGES: Readonly<Record<string, string>> = {
  french: 'fr',
  francais: 'fr',
  frenchb: 'fr',
  acadian: 'fr',
  canadien: 'fr',
  english: 'en-US',
  american: 'en-US',
  USenglish: 'en-US',
  usenglish: 'en-US',
  canadian: 'en-CA',
  british: 'en-GB',
  UKenglish: 'en-GB',
  ukenglish: 'en-GB',
  australian: 'en-AU',
  newzealand: 'en-NZ',
  german: 'de-DE',
  ngerman: 'de-DE',
  austrian: 'de-AT',
  naustrian: 'de-AT',
  swissgerman: 'de-CH',
  nswissgerman: 'de-CH',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt-PT',
  portuges: 'pt-PT',
  brazil: 'pt-BR',
  brazilian: 'pt-BR',
  dutch: 'nl',
  catalan: 'ca-ES',
  polish: 'pl-PL',
  russian: 'ru-RU',
};

function splitOptions(options: string): string[] {
  return options
    .split(',')
    .map((option) => option.trim())
    .filter((option) => option !== '');
}

/** The language a list of babel options makes the main one: `main=`, or the last language. */
function babelMain(options: readonly string[]): string | null {
  let main: string | null = null;
  for (const option of options) {
    const [key, value] = option.split('=').map((part) => part.trim());
    if (value !== undefined) {
      if (key === 'main' && LANGUAGES[value] !== undefined) return LANGUAGES[value];
      continue;
    }
    if (key !== undefined && LANGUAGES[key] !== undefined) main = LANGUAGES[key];
  }
  return main;
}

/**
 * Main language of a document, as a LanguageTool code, read from babel
 * (`main=` or the last language option, possibly given to the document
 * class) or from polyglossia's `\setdefaultlanguage`/`\setmainlanguage`.
 * Returns null when the source does not say.
 */
export function detectLanguage(source: string): string | null {
  let classOptions: string[] = [];
  let babel: string | null = null;
  let polyglossia: string | null = null;
  for (const token of scanCommands(source)) {
    if (token.name === 'documentclass' || token.name === 'usepackage') {
      const { end, optionals } = skipOptionals(source, token.end);
      const options = splitOptions(optionals.join(','));
      const packages = readGroup(source, end);
      if (token.name === 'documentclass') {
        classOptions = options;
      } else if (packages !== null && splitOptions(packages.content).includes('babel')) {
        babel = babelMain([...classOptions, ...options]);
      }
    } else if (token.name === 'setdefaultlanguage' || token.name === 'setmainlanguage') {
      const { end, optionals } = skipOptionals(source, token.end);
      const name = readGroup(source, end)?.content.trim();
      if (name === undefined) continue;
      const variant = /variant\s*=\s*(\w+)/.exec(optionals.join(','))?.[1];
      if (name === 'english' && (variant === 'british' || variant === 'uk')) polyglossia = 'en-GB';
      else polyglossia = LANGUAGES[name] ?? polyglossia;
    } else if (token.name === 'begin') {
      if (readGroup(source, token.end)?.content === 'document') break;
    }
  }
  return polyglossia ?? babel;
}

/** Packages that classes such as beamer load themselves. */
const CLASS_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  beamer: ['graphicx', 'amsmath', 'amssymb', 'xcolor', 'hyperref'],
  amsart: ['amsmath'],
  amsbook: ['amsmath'],
  amsproc: ['amsmath'],
};

/** Packages loaded by a source file with `\usepackage` or `\RequirePackage`, and by its class. */
export function loadedPackages(source: string): string[] {
  const loaded = new Set<string>();
  for (const token of scanCommands(source)) {
    if (
      token.name !== 'usepackage' &&
      token.name !== 'RequirePackage' &&
      token.name !== 'documentclass'
    ) {
      continue;
    }
    const { end } = skipOptionals(source, token.end);
    const names = splitOptions(readGroup(source, end)?.content ?? '');
    for (const name of names) {
      if (token.name === 'documentclass') {
        for (const implied of CLASS_PACKAGES[name] ?? []) loaded.add(implied);
      } else {
        loaded.add(name);
      }
    }
  }
  return [...loaded].sort();
}
