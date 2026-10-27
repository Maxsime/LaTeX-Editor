import * as z from 'zod/mini';

/** Default motif of generated citation keys, e.g. `dupont2024analyse`. */
export const DEFAULT_CITE_KEY_PATTERN = '[auth:lower][year][shorttitle:lower]';

/** A citation key motif: literal key characters and `[token:modifier]` fields. */
export const citeKeyPattern = z
  .string()
  .check(z.minLength(1), z.maxLength(100), z.regex(/^[A-Za-z0-9_:.\-[\]]+$/));

/** chktex warnings off by default: the noisiest ones on ordinary documents. */
export const DEFAULT_CHKTEX_DISABLED = [1, 8, 13, 36, 44];

export const chktexDisabled = z
  .array(z.number().check(z.int(), z.gte(1), z.lte(99)))
  .check(z.maxLength(99));

/** Languages LanguageTool checks, as its codes; `auto` reads the document, then guesses. */
export const spellLanguages = [
  'auto',
  'fr',
  'en-US',
  'en-GB',
  'en-CA',
  'en-AU',
  'en-NZ',
  'de-DE',
  'de-AT',
  'de-CH',
  'es',
  'it',
  'pt-PT',
  'pt-BR',
  'nl',
  'ca-ES',
  'pl-PL',
  'ru-RU',
] as const;
export const spellLanguage = z.enum(spellLanguages);
export type SpellLanguage = z.infer<typeof spellLanguage>;

// --- Bibliography ---------------------------------------------------------------

export const lookupSource = z.enum(['doi', 'arxiv', 'isbn', 'bibtex']);
export type LookupSource = z.infer<typeof lookupSource>;

/** Longest BibTeX text accepted for a paste. */
export const MAX_PASTED_BIBTEX = 200_000;

/** Body of `POST /api/projects/:id/bibliography/lookup`. */
export const lookupRequest = z.object({
  source: lookupSource,
  query: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PASTED_BIBTEX)),
  /** Pasted BibTeX only: keep the keys as written, unless already used in the project. */
  keepKeys: z._default(z.boolean(), false),
});
export type LookupRequest = z.input<typeof lookupRequest>;

/** An entry ready to add to a `.bib` file, under a key free in the project. */
export const importedEntry = z.object({
  key: z.string(),
  type: z.string(),
  title: z.nullable(z.string()),
  authors: z.array(z.string()),
  year: z.nullable(z.string()),
  bibtex: z.string(),
});
export type ImportedEntry = z.infer<typeof importedEntry>;

export const lookupResponse = z.object({ entries: z.array(importedEntry) });
export type LookupResponse = z.infer<typeof lookupResponse>;

/** The Zotero library linked to the current user; the key itself is never returned. */
export const zoteroAccount = z.object({
  connected: z.boolean(),
  username: z.nullable(z.string()),
  /** Last four characters of the API key. */
  keyHint: z.nullable(z.string()),
});
export type ZoteroAccount = z.infer<typeof zoteroAccount>;

export const connectZoteroRequest = z.object({
  apiKey: z.string().check(z.trim(), z.regex(/^[A-Za-z0-9]{24}$/)),
});
export type ConnectZoteroRequest = z.input<typeof connectZoteroRequest>;

export const zoteroSearchQuery = z.object({
  q: z._default(z.string().check(z.maxLength(200)), ''),
});

export const zoteroItem = z.object({
  key: z.string(),
  type: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.nullable(z.string()),
});
export type ZoteroItem = z.infer<typeof zoteroItem>;

export const zoteroItemsResponse = z.object({ items: z.array(zoteroItem) });
export type ZoteroItemsResponse = z.infer<typeof zoteroItemsResponse>;

export const zoteroImportRequest = z.object({
  itemKeys: z
    .array(z.string().check(z.regex(/^[A-Z0-9]{8}$/)))
    .check(z.minLength(1), z.maxLength(50)),
});
export type ZoteroImportRequest = z.input<typeof zoteroImportRequest>;

// --- Spelling and grammar -----------------------------------------------------------

/** Longest text checked by one request, markup included (LanguageTool's own default is 20 000). */
export const MAX_SPELLING_LENGTH = 20_000;

export const annotationSegment = z.union([
  z.object({ text: z.string() }),
  z.object({ markup: z.string(), interpretAs: z.optional(z.string().check(z.maxLength(100))) }),
]);

/** Body of `POST /api/projects/:id/spelling`: annotated text from `toAnnotation`. */
export const spellingRequest = z.object({
  annotation: z.array(annotationSegment).check(
    z.minLength(1),
    z.maxLength(5_000),
    z.refine(
      (segments) =>
        segments.reduce(
          (length, segment) =>
            length + ('text' in segment ? segment.text.length : segment.markup.length),
          0,
        ) <= MAX_SPELLING_LENGTH,
      'too long',
    ),
  ),
  /** Language of the file when known by the client; the project setting and document come first. */
  language: z.optional(spellLanguage),
});
export type SpellingRequest = z.input<typeof spellingRequest>;

export const spellingKind = z.enum(['spelling', 'grammar', 'style']);
export type SpellingKind = z.infer<typeof spellingKind>;

export const spellingMatch = z.object({
  /** Offsets in the annotated text, that is in the source it was made from. */
  offset: z.number(),
  length: z.number(),
  message: z.string(),
  replacements: z.array(z.string()),
  ruleId: z.string(),
  kind: spellingKind,
});
export type SpellingMatch = z.infer<typeof spellingMatch>;

export const spellingResponse = z.object({
  /** Language actually used, e.g. `fr` or `en-US`. */
  language: z.string(),
  matches: z.array(spellingMatch),
});
export type SpellingResponse = z.infer<typeof spellingResponse>;

/** Most words of a personal dictionary. */
export const MAX_DICTIONARY_WORDS = 5_000;

export const dictionaryWord = z
  .string()
  .check(z.trim(), z.minLength(1), z.maxLength(100), z.regex(/^\S+$/));

export const dictionaryRequest = z.object({ word: dictionaryWord });
export type DictionaryRequest = z.input<typeof dictionaryRequest>;

export const dictionaryResponse = z.object({ words: z.array(z.string()) });
export type DictionaryResponse = z.infer<typeof dictionaryResponse>;
