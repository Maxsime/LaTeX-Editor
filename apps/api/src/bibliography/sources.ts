import { ApiError } from '@galley/shared';
import { XMLParser } from 'fast-xml-parser';
import * as z from 'zod/mini';
import {
  cleanText,
  type Person,
  type Reference,
  type ReferenceType,
  splitName,
} from './reference.js';

/** Where the bibliographic services live, from the API configuration. */
export interface LookupConfig {
  CROSSREF_URL: string;
  CROSSREF_MAILTO?: string | undefined;
  ARXIV_URL: string;
  OPENLIBRARY_URL: string;
}

const TIMEOUT_MS = 8_000;
/** Largest response read from a service; a record is a few kilobytes. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PROJECT_URL = 'https://github.com/Maxsime/LaTeX-Editor';

/** User-Agent sent to the services; Crossref asks for a contact to serve the "polite" pool. */
export function userAgent(mailto?: string): string {
  return `Galley (${PROJECT_URL}${mailto === undefined ? '' : `; mailto:${mailto}`})`;
}

export type Fetch = typeof fetch;

/**
 * Fetches a URL built by this module from a fixed base and a validated
 * identifier, never from user input as such. Returns null on a `missing`
 * status (404 by default); a service that cannot be reached, fails, answers
 * slowly or too much is SERVICE_UNAVAILABLE.
 */
export async function fetchText(
  fetcher: Fetch,
  url: URL,
  headers: Record<string, string>,
  missing: readonly number[] = [404],
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError('SERVICE_UNAVAILABLE', `${url.host} unreachable`);
  }
  if (missing.includes(response.status)) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new ApiError('SERVICE_UNAVAILABLE', `${url.host} answered ${String(response.status)}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    // The DOM typing of ReadableStream lacks its async iterator, which Node provides.
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new ApiError('SERVICE_UNAVAILABLE', `${url.host} answered too much`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('SERVICE_UNAVAILABLE', `${url.host} interrupted`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function invalid(what: string): ApiError {
  return new ApiError('IDENTIFIER_INVALID', `invalid ${what}`);
}

function notFound(): ApiError {
  return new ApiError('REFERENCE_NOT_FOUND');
}

// --- Identifiers ------------------------------------------------------------------

/** A DOI from `10.x/y`, `doi:10.x/y` or a doi.org link. */
export function normaliseDoi(input: string): string {
  const doi = input
    .trim()
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(doi) || doi.length > 300) throw invalid('DOI');
  if (doi.split('/').some((segment) => segment === '.' || segment === '..')) throw invalid('DOI');
  return doi;
}

/** An arXiv identifier, new (`2101.00001v2`) or old style (`hep-th/9901001`), from an id or a link. */
export function normaliseArxiv(input: string): string {
  const id = input
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/^arxiv:\s*/i, '')
    .replace(/\.pdf$/i, '');
  if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/.test(id)) {
    throw invalid('arXiv identifier');
  }
  return id;
}

/** An ISBN-10 or ISBN-13 with a valid check digit, without separators. */
export function normaliseIsbn(input: string): string {
  const isbn = input
    .trim()
    .replace(/^isbn(?:-1[03])?:?\s*/i, '')
    .replace(/[\s-]/g, '')
    .toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    // ASCII digits only here, so splitting into UTF-16 units is safe.
    const sum = isbn
      .split('')
      .reduce((total, char, index) => total + (char === 'X' ? 10 : Number(char)) * (10 - index), 0);
    if (sum % 11 === 0) return isbn;
  } else if (/^\d{13}$/.test(isbn)) {
    const sum = isbn
      .split('')
      .reduce((total, char, index) => total + Number(char) * (index % 2 === 0 ? 1 : 3), 0);
    if (sum % 10 === 0) return isbn;
  }
  throw invalid('ISBN');
}

// --- Crossref ---------------------------------------------------------------------

const optionalText = z.optional(z.string());
const textList = z.optional(z.array(z.string()));

const crossrefPerson = z.object({ given: optionalText, family: optionalText, name: optionalText });
type CrossrefPerson = z.infer<typeof crossrefPerson>;

const crossrefDate = z.optional(
  z.object({ 'date-parts': z.optional(z.array(z.array(z.nullable(z.number())))) }),
);

const crossrefWork = z.object({
  type: optionalText,
  title: textList,
  subtitle: textList,
  author: z.optional(z.array(crossrefPerson)),
  editor: z.optional(z.array(crossrefPerson)),
  'container-title': textList,
  volume: optionalText,
  issue: optionalText,
  page: optionalText,
  publisher: optionalText,
  'publisher-location': optionalText,
  ISBN: textList,
  DOI: optionalText,
  issued: crossrefDate,
  'published-print': crossrefDate,
  'published-online': crossrefDate,
  institution: z.optional(z.array(z.object({ name: optionalText }))),
});
type CrossrefWork = z.infer<typeof crossrefWork>;

/** Parses a service's JSON answer; one that does not have the documented shape is SERVICE_UNAVAILABLE. */
export function parseJson<Schema extends z.ZodMiniType>(
  body: string,
  schema: Schema,
): z.output<Schema> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ApiError('SERVICE_UNAVAILABLE', 'malformed answer');
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError('SERVICE_UNAVAILABLE', 'unexpected answer');
  return result.data;
}

const CROSSREF_TYPES: Readonly<Record<string, ReferenceType>> = {
  'journal-article': 'article',
  'proceedings-article': 'inproceedings',
  'book-chapter': 'incollection',
  'book-section': 'incollection',
  'book-part': 'incollection',
  'reference-entry': 'incollection',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  dissertation: 'phdthesis',
  report: 'techreport',
};

function crossrefPeople(people: readonly CrossrefPerson[] | undefined): Person[] {
  return (people ?? []).flatMap((person): Person[] => {
    if (person.family !== undefined) {
      return [
        person.given === undefined
          ? { family: cleanText(person.family) }
          : { family: cleanText(person.family), given: cleanText(person.given) },
      ];
    }
    return person.name === undefined ? [] : [{ family: cleanText(person.name), literal: true }];
  });
}

function crossrefYear(work: CrossrefWork): string | null {
  for (const date of [work.issued, work['published-print'], work['published-online']]) {
    const year = date?.['date-parts']?.[0]?.[0];
    if (typeof year === 'number') return String(year);
  }
  return null;
}

/** Reads a Crossref `/works/{doi}` response body. */
export function parseCrossref(body: string): Reference {
  const work = parseJson(body, z.object({ message: z.optional(crossrefWork) })).message;
  if (work === undefined) throw notFound();
  const type = CROSSREF_TYPES[work.type ?? ''] ?? 'misc';
  const title = work.title?.[0];
  const subtitle = work.subtitle?.[0];
  const container = work['container-title']?.[0];
  const reference: Reference = {
    type,
    title:
      title === undefined
        ? null
        : cleanText(subtitle === undefined ? title : `${title}: ${subtitle}`),
    authors: crossrefPeople(work.author),
    editors: crossrefPeople(work.editor),
    year: crossrefYear(work),
  };
  if (container !== undefined) {
    if (type === 'article') reference.journal = cleanText(container);
    else if (type === 'inproceedings' || type === 'incollection') {
      reference.booktitle = cleanText(container);
    }
  }
  if (work.volume !== undefined) reference.volume = work.volume;
  if (work.issue !== undefined) reference.number = work.issue;
  if (work.page !== undefined) reference.pages = work.page;
  if (work.publisher !== undefined && type !== 'article')
    reference.publisher = cleanText(work.publisher);
  if (work['publisher-location'] !== undefined && type !== 'article') {
    reference.address = cleanText(work['publisher-location']);
  }
  const institution = work.institution?.[0]?.name;
  if (institution !== undefined) {
    if (type === 'phdthesis') reference.school = cleanText(institution);
    else if (type === 'techreport') reference.institution = cleanText(institution);
  }
  if (type === 'book' && work.ISBN?.[0] !== undefined) reference.isbn = work.ISBN[0];
  if (work.DOI !== undefined) reference.doi = work.DOI;
  return reference;
}

/** Looks a DOI up on Crossref. */
export async function lookupDoi(
  config: LookupConfig,
  fetcher: Fetch,
  input: string,
): Promise<Reference> {
  const doi = normaliseDoi(input);
  const path = doi.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`works/${path}`, withSlash(config.CROSSREF_URL));
  const body = await fetchText(fetcher, url, {
    accept: 'application/json',
    'user-agent': userAgent(config.CROSSREF_MAILTO),
  });
  if (body === null) throw notFound();
  return parseCrossref(body);
}

// --- arXiv ------------------------------------------------------------------------

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // Entities stay literal: no expansion, so no "billion laughs".
  processEntities: false,
  isArray: (name) => name === 'entry' || name === 'author' || name === 'link',
});

/** A text element, or one with attributes (`#text` holds its text). */
const xmlText = z.optional(z.union([z.string(), z.object({ '#text': z.optional(z.string()) })]));

const atomFeed = z.object({
  feed: z.optional(
    z.object({
      entry: z.optional(
        z.array(
          z.object({
            id: z.optional(z.string()),
            title: xmlText,
            published: z.optional(z.string()),
            author: z.optional(z.array(z.object({ name: xmlText }))),
            'arxiv:primary_category': z.optional(z.object({ term: z.optional(z.string()) })),
            'arxiv:doi': xmlText,
            'arxiv:journal_ref': xmlText,
          }),
        ),
      ),
    }),
  ),
});

function textOf(value: z.infer<typeof xmlText>): string | undefined {
  return typeof value === 'string' ? value : value?.['#text'];
}

/** Reads the Atom feed of arXiv's query API for one identifier. */
export function parseArxiv(body: string, id: string): Reference {
  const parsed = atomFeed.safeParse(xml.parse(body));
  if (!parsed.success) throw new ApiError('SERVICE_UNAVAILABLE', 'unexpected answer');
  const feed = parsed.data;
  const entry = feed.feed?.entry?.find(
    (candidate) => candidate.id !== undefined && !candidate.id.includes('/api/errors'),
  );
  if (entry?.id === undefined) throw notFound();
  const eprint = /arxiv\.org\/abs\/(.+?)(?:v\d+)?$/.exec(entry.id)?.[1] ?? id.replace(/v\d+$/, '');
  const reference: Reference = {
    type: 'misc',
    title:
      textOf(entry.title) === undefined
        ? null
        : cleanText(decodeEntities(textOf(entry.title) ?? '')),
    authors: (entry.author ?? []).flatMap((author) => {
      const name = textOf(author.name);
      return name === undefined ? [] : [splitName(decodeEntities(name))];
    }),
    editors: [],
    year: /^(\d{4})/.exec(entry.published ?? '')?.[1] ?? null,
    eprint,
    archiveprefix: 'arXiv',
    url: `https://arxiv.org/abs/${eprint}`,
  };
  const category = entry['arxiv:primary_category']?.term;
  if (category !== undefined) reference.primaryclass = category;
  const doi = textOf(entry['arxiv:doi']);
  if (doi !== undefined) reference.doi = doi.trim();
  const journal = textOf(entry['arxiv:journal_ref']);
  if (journal !== undefined) reference.note = cleanText(decodeEntities(journal));
  return reference;
}

/** The few XML entities a feed holds, decoded by hand since the parser leaves them. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Looks an identifier up on arXiv. */
export async function lookupArxiv(
  config: LookupConfig,
  fetcher: Fetch,
  input: string,
): Promise<Reference> {
  const id = normaliseArxiv(input);
  const url = new URL('api/query', withSlash(config.ARXIV_URL));
  url.searchParams.set('id_list', id);
  const body = await fetchText(fetcher, url, {
    accept: 'application/atom+xml',
    'user-agent': userAgent(config.CROSSREF_MAILTO),
  });
  if (body === null) throw notFound();
  return parseArxiv(body, id);
}

// --- Open Library -----------------------------------------------------------------

const named = z.optional(z.array(z.object({ name: optionalText })));

const openLibraryBook = z.object({
  title: optionalText,
  subtitle: optionalText,
  authors: named,
  publishers: named,
  publish_places: named,
  publish_date: optionalText,
});

/** Reads Open Library's `/api/books?jscmd=data` response for one ISBN. */
export function parseOpenLibrary(body: string, isbn: string): Reference {
  const books = parseJson(body, z.record(z.string(), openLibraryBook));
  const book = books[`ISBN:${isbn}`];
  if (book === undefined) throw notFound();
  const reference: Reference = {
    type: 'book',
    title:
      book.title === undefined
        ? null
        : cleanText(book.subtitle === undefined ? book.title : `${book.title}: ${book.subtitle}`),
    authors: (book.authors ?? []).flatMap((author) =>
      author.name === undefined ? [] : [splitName(author.name)],
    ),
    editors: [],
    year: /\d{4}/.exec(book.publish_date ?? '')?.[0] ?? null,
    isbn,
  };
  const publisher = book.publishers?.[0]?.name;
  if (publisher !== undefined) reference.publisher = cleanText(publisher);
  const place = book.publish_places?.[0]?.name;
  if (place !== undefined) reference.address = cleanText(place);
  return reference;
}

/** Looks an ISBN up on Open Library. */
export async function lookupIsbn(
  config: LookupConfig,
  fetcher: Fetch,
  input: string,
): Promise<Reference> {
  const isbn = normaliseIsbn(input);
  const url = new URL('api/books', withSlash(config.OPENLIBRARY_URL));
  url.searchParams.set('bibkeys', `ISBN:${isbn}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('jscmd', 'data');
  const body = await fetchText(fetcher, url, {
    accept: 'application/json',
    'user-agent': userAgent(config.CROSSREF_MAILTO),
  });
  if (body === null) throw notFound();
  return parseOpenLibrary(body, isbn);
}

/** Base URL with a trailing slash, so that relative paths extend it rather than replace its last segment. */
export function withSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}
