import { type AnnotationSegment, annotationSource } from '@galley/latex-index';
import { ApiError, type SpellingKind, type SpellingMatch } from '@galley/shared';
import * as z from 'zod/mini';
import { parseJson, withSlash } from '../bibliography/sources.js';

const TIMEOUT_MS = 15_000;
const MAX_REPLACEMENTS = 5;

/**
 * Rules about how text is typed rather than written, which LaTeX handles
 * itself: repeated spaces, the spaces of French punctuation (babel adds them),
 * typographic apostrophes and quotes.
 */
export const DISABLED_RULES = [
  'WHITESPACE_RULE',
  'FRENCH_WHITESPACE',
  'FRENCH_WHITESPACE_STRICT',
  'APOS_TYP',
  'APOS_INCORRECT',
  'EN_QUOTES',
  'TYPOGRAPHY',
  'DOUBLE_PUNCTUATION',
];

const toolResponse = z.object({
  language: z.optional(
    z.object({
      code: z.optional(z.string()),
      detectedLanguage: z.optional(z.object({ code: z.optional(z.string()) })),
    }),
  ),
  matches: z.optional(
    z.array(
      z.object({
        message: z.optional(z.string()),
        shortMessage: z.optional(z.string()),
        offset: z.optional(z.number()),
        length: z.optional(z.number()),
        replacements: z.optional(z.array(z.object({ value: z.optional(z.string()) }))),
        rule: z.optional(
          z.object({ id: z.optional(z.string()), issueType: z.optional(z.string()) }),
        ),
      }),
    ),
  ),
});

function kindOf(issueType: string | undefined): SpellingKind {
  if (issueType === 'misspelling') return 'spelling';
  if (issueType === 'style' || issueType === 'register' || issueType === 'locale-violation') {
    return 'style';
  }
  return 'grammar';
}

/** What {@link checkText} needs besides the text. */
export interface CheckOptions {
  /** A LanguageTool code, or `auto`. */
  language: string;
  /** Words of the personal dictionary: misspellings of them are dropped. */
  dictionary: ReadonlySet<string>;
}

/**
 * Sends annotated text to LanguageTool and returns its matches, with offsets
 * in the source the annotation was made from. Matches on a word of the
 * personal dictionary are dropped.
 */
export async function checkText(
  baseUrl: string,
  annotation: readonly AnnotationSegment[],
  options: CheckOptions,
): Promise<{ language: string; matches: SpellingMatch[] }> {
  const form = new URLSearchParams();
  form.set('data', JSON.stringify({ annotation }));
  form.set('language', options.language);
  if (options.language === 'auto') form.set('preferredVariants', 'en-US,de-DE,pt-PT,ca-ES');
  form.set('disabledRules', DISABLED_RULES.join(','));
  let response: Response;
  try {
    response = await fetch(new URL('v2/check', withSlash(baseUrl)), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError('SERVICE_UNAVAILABLE', 'LanguageTool unreachable');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError('SERVICE_UNAVAILABLE', `LanguageTool answered ${String(response.status)}`);
  }
  const body = parseJson(await response.text(), toolResponse);
  const source = annotationSource(annotation);
  const folded = new Set([...options.dictionary].map((word) => word.toLowerCase()));
  const matches: SpellingMatch[] = [];
  for (const match of body.matches ?? []) {
    if (match.offset === undefined || match.length === undefined) continue;
    const kind = kindOf(match.rule?.issueType);
    const word = source.slice(match.offset, match.offset + match.length);
    if (kind === 'spelling' && (options.dictionary.has(word) || folded.has(word.toLowerCase()))) {
      continue;
    }
    matches.push({
      offset: match.offset,
      length: match.length,
      message: match.message ?? match.shortMessage ?? '',
      replacements: (match.replacements ?? [])
        .slice(0, MAX_REPLACEMENTS)
        .flatMap((replacement) => (replacement.value === undefined ? [] : [replacement.value])),
      ruleId: match.rule?.id ?? '',
      kind,
    });
  }
  const language =
    body.language?.code === undefined || options.language !== 'auto'
      ? options.language
      : (body.language.detectedLanguage?.code ?? body.language.code);
  return { language, matches };
}
