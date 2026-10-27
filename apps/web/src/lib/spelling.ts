import {
  type AnnotationSegment,
  annotationSource,
  splitParagraphs,
  toAnnotation,
} from '@galley/latex-index';
import { MAX_SPELLING_LENGTH, type SpellingMatch, type SpellingResponse } from '@galley/shared';

/** A report placed in the checked source. */
export interface SpellIssue {
  from: number;
  to: number;
  /** The reported text, as written in the source. */
  word: string;
  match: SpellingMatch;
}

/** Sends one batch of annotated text to the API. */
export type SpellRequest = (annotation: AnnotationSegment[]) => Promise<SpellingResponse>;

/** Most segments in one request, below the API's own limit. */
const MAX_SEGMENTS = 4_000;
/** Paragraphs remembered; past it the cache starts over. */
const MAX_CACHED = 5_000;
/** Wait after a refused or failed request before calling the service again. */
const BACKOFF_MS = 60_000;
/** Between paragraphs of a batch: LanguageTool reads it as a paragraph break. */
const SEPARATOR = { markup: '\n\n', interpretAs: '\n\n' } satisfies AnnotationSegment;

interface Paragraph {
  offset: number;
  source: string;
  segments: AnnotationSegment[];
  /** Cache key: the same text may read differently (inside a formula, a verbatim). */
  key: string;
}

/** Groups paragraphs into requests that stay within the API limits; a paragraph too long alone is left out. */
export function batchParagraphs<T extends { source: string; segments: AnnotationSegment[] }>(
  paragraphs: readonly T[],
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let length = 0;
  let segments = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.source.length > MAX_SPELLING_LENGTH || paragraph.segments.length > MAX_SEGMENTS) {
      continue;
    }
    const extra = paragraph.source.length + SEPARATOR.markup.length;
    if (
      current.length > 0 &&
      (length + extra > MAX_SPELLING_LENGTH ||
        segments + paragraph.segments.length + 1 > MAX_SEGMENTS)
    ) {
      batches.push(current);
      current = [];
      length = 0;
      segments = 0;
    }
    current.push(paragraph);
    length += extra;
    segments += paragraph.segments.length + 1;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Splits the matches of one batch between its paragraphs, with offsets
 * relative to each paragraph. A match across a separator is dropped.
 */
export function splitMatches(
  sources: readonly string[],
  matches: readonly SpellingMatch[],
): SpellingMatch[][] {
  const result: SpellingMatch[][] = sources.map(() => []);
  let start = 0;
  sources.forEach((source, index) => {
    const end = start + source.length;
    for (const match of matches) {
      if (match.offset >= start && match.offset + match.length <= end) {
        result[index]?.push({ ...match, offset: match.offset - start });
      }
    }
    start = end + SEPARATOR.markup.length;
  });
  return result;
}

/**
 * Checks LaTeX sources paragraph by paragraph. Results are cached by
 * paragraph text, so after an edit only the changed paragraphs are sent.
 */
export class SpellChecker {
  /** Matches of each paragraph, by {@link Paragraph.key}. */
  private readonly cache = new Map<string, SpellingMatch[]>();
  private readonly ignored = new Set<string>();
  private dictionary = new Set<string>();
  private pausedUntil = 0;

  constructor(
    private readonly request: SpellRequest,
    private readonly now: () => number = Date.now,
  ) {}

  /** Words accepted by the user, as their personal dictionary holds them. */
  setDictionary(words: Iterable<string>): void {
    this.dictionary = new Set(words);
  }

  /** Hides this report of this text until the page is reloaded. */
  ignore(issue: SpellIssue): void {
    this.ignored.add(ignoreKey(issue.match.ruleId, issue.word));
  }

  async check(source: string): Promise<SpellIssue[]> {
    const paragraphs: Paragraph[] = splitParagraphs(toAnnotation(source)).map((paragraph) => ({
      ...paragraph,
      source: annotationSource(paragraph.segments),
      key: JSON.stringify(paragraph.segments),
    }));
    const missing = paragraphs.filter((paragraph) => !this.cache.has(paragraph.key));
    if (missing.length > 0 && this.now() >= this.pausedUntil) {
      for (const batch of batchParagraphs(missing)) {
        const annotation = batch.flatMap((paragraph, index) =>
          index === 0 ? paragraph.segments : [SEPARATOR, ...paragraph.segments],
        );
        let response: SpellingResponse;
        try {
          response = await this.request(annotation);
        } catch {
          // Service down or rate limit reached: show what is known, retry later.
          this.pausedUntil = this.now() + BACKOFF_MS;
          break;
        }
        if (this.cache.size > MAX_CACHED) this.cache.clear();
        const sources = batch.map((paragraph) => paragraph.source);
        splitMatches(sources, response.matches).forEach((matches, index) => {
          const paragraph = batch[index];
          if (paragraph) this.cache.set(paragraph.key, matches);
        });
      }
    }
    const issues: SpellIssue[] = [];
    for (const paragraph of paragraphs) {
      for (const match of this.cache.get(paragraph.key) ?? []) {
        const from = paragraph.offset + match.offset;
        const word = source.slice(from, from + match.length);
        if (this.ignored.has(ignoreKey(match.ruleId, word))) continue;
        if (match.kind === 'spelling' && this.dictionary.has(word)) continue;
        issues.push({ from, to: from + match.length, word, match });
      }
    }
    return issues;
  }
}

function ignoreKey(ruleId: string, word: string): string {
  return `${ruleId}\u0000${word}`;
}
