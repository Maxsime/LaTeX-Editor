import { type LiteratureResult, ToolError } from '@galley/ai';
import * as z from 'zod/mini';
import type { ApiConfig } from '../config.js';
import {
  type Fetch,
  fetchText,
  parseArxivFeed,
  parseJson,
  userAgent,
  withSlash,
} from '../bibliography/sources.js';

/** Results asked of each service; merged, at most {@link MAX_RESULTS} are returned. */
const PER_SERVICE = 6;
const MAX_RESULTS = 10;

const text = z.optional(z.nullable(z.string()));

const crossrefSearch = z.object({
  message: z.object({
    items: z.array(
      z.object({
        DOI: text,
        title: z.optional(z.array(z.string())),
        author: z.optional(z.array(z.object({ family: text, given: text, name: text }))),
        issued: z.optional(
          z.object({ 'date-parts': z.optional(z.array(z.array(z.nullable(z.number())))) }),
        ),
        'container-title': z.optional(z.array(z.string())),
      }),
    ),
  }),
});

const openAlexSearch = z.object({
  results: z.array(
    z.object({
      doi: text,
      title: text,
      publication_year: z.optional(z.nullable(z.number())),
      authorships: z.optional(
        z.array(z.object({ author: z.optional(z.object({ display_name: text })) })),
      ),
      primary_location: z.optional(
        z.nullable(z.object({ source: z.optional(z.nullable(z.object({ display_name: text }))) })),
      ),
    }),
  ),
});

const semanticScholarSearch = z.object({
  data: z.optional(
    z.array(
      z.object({
        title: text,
        year: z.optional(z.nullable(z.number())),
        venue: text,
        authors: z.optional(z.array(z.object({ name: text }))),
        externalIds: z.optional(
          z.nullable(z.object({ DOI: z.optional(z.string()), ArXiv: z.optional(z.string()) })),
        ),
      }),
    ),
  ),
});

function cleanDoi(doi: string | null | undefined): string | null {
  if (doi === null || doi === undefined || doi === '') return null;
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== '';
}

async function crossref(config: ApiConfig, fetcher: Fetch, query: string) {
  const url = new URL('works', withSlash(config.CROSSREF_URL));
  url.searchParams.set('query.bibliographic', query);
  url.searchParams.set('rows', String(PER_SERVICE));
  url.searchParams.set('select', 'DOI,title,author,issued,container-title');
  const body = await fetchText(fetcher, url, {
    accept: 'application/json',
    'user-agent': userAgent(config.CROSSREF_MAILTO),
  });
  if (body === null) return [];
  return parseJson(body, crossrefSearch).message.items.map((item): LiteratureResult => ({
    title: item.title?.[0] ?? '',
    authors: (item.author ?? []).flatMap((author) => {
      const name = [author.given, author.family].filter(present).join(' ') || author.name;
      return present(name) ? [name] : [];
    }),
    year: item.issued?.['date-parts']?.[0]?.[0] ?? null,
    doi: cleanDoi(item.DOI),
    arxivId: null,
    venue: item['container-title']?.[0] ?? null,
  }));
}

async function arxiv(config: ApiConfig, fetcher: Fetch, query: string) {
  const url = new URL('api/query', withSlash(config.ARXIV_URL));
  // Quoted phrases and field prefixes would let a query reshape arXiv's syntax: keep words only.
  const words = query
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 12);
  url.searchParams.set('search_query', words.map((word) => `all:${word}`).join(' AND '));
  url.searchParams.set('max_results', String(PER_SERVICE));
  const body = await fetchText(fetcher, url, {
    accept: 'application/atom+xml',
    'user-agent': userAgent(config.CROSSREF_MAILTO),
  });
  if (body === null) return [];
  return parseArxivFeed(body).map((reference): LiteratureResult => ({
    title: reference.title ?? '',
    authors: reference.authors.map((person) =>
      [person.given, person.family].filter(present).join(' '),
    ),
    year: reference.year === null ? null : Number(reference.year),
    doi: reference.doi ?? null,
    arxivId: reference.eprint ?? null,
    venue: 'arXiv',
  }));
}

async function openAlex(config: ApiConfig, fetcher: Fetch, query: string) {
  const url = new URL('works', withSlash(config.OPENALEX_URL));
  url.searchParams.set('search', query);
  url.searchParams.set('per-page', String(PER_SERVICE));
  if (present(config.CROSSREF_MAILTO)) url.searchParams.set('mailto', config.CROSSREF_MAILTO);
  const body = await fetchText(fetcher, url, {
    accept: 'application/json',
    'user-agent': userAgent(config.CROSSREF_MAILTO),
  });
  if (body === null) return [];
  return parseJson(body, openAlexSearch).results.map((work): LiteratureResult => ({
    title: work.title ?? '',
    authors: (work.authorships ?? []).flatMap((entry) =>
      present(entry.author?.display_name) ? [entry.author.display_name] : [],
    ),
    year: work.publication_year ?? null,
    doi: cleanDoi(work.doi),
    arxivId: null,
    venue: work.primary_location?.source?.display_name ?? null,
  }));
}

async function semanticScholar(config: ApiConfig, fetcher: Fetch, query: string, key: string) {
  const url = new URL('graph/v1/paper/search', withSlash(config.SEMANTIC_SCHOLAR_URL));
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(PER_SERVICE));
  url.searchParams.set('fields', 'title,year,venue,authors,externalIds');
  const body = await fetchText(fetcher, url, {
    accept: 'application/json',
    'user-agent': userAgent(config.CROSSREF_MAILTO),
    'x-api-key': key,
  });
  if (body === null) return [];
  return (parseJson(body, semanticScholarSearch).data ?? []).map((paper): LiteratureResult => ({
    title: paper.title ?? '',
    authors: (paper.authors ?? []).flatMap((author) => (present(author.name) ? [author.name] : [])),
    year: paper.year ?? null,
    doi: cleanDoi(paper.externalIds?.DOI),
    arxivId: paper.externalIds?.ArXiv ?? null,
    venue: present(paper.venue) ? paper.venue : null,
  }));
}

function identity(result: LiteratureResult): string {
  if (result.doi !== null) return `doi:${result.doi.toLowerCase()}`;
  if (result.arxivId !== null) return `arxiv:${result.arxivId.toLowerCase()}`;
  return `title:${result.title.toLowerCase().replace(/\W+/g, ' ').trim()}`;
}

/**
 * Searches Crossref, arXiv and OpenAlex in parallel, plus Semantic Scholar
 * when the instance has a key (SPEC §3.8), and merges the answers: one result
 * per DOI, arXiv identifier or title, the services interleaved so that each
 * contributes its best matches. Only fixed hosts are called.
 */
export async function searchLiterature(
  config: ApiConfig,
  fetcher: Fetch,
  query: string,
): Promise<LiteratureResult[]> {
  const key = config.SEMANTIC_SCHOLAR_API_KEY;
  const searches = [crossref, arxiv, openAlex].map((search) => search(config, fetcher, query));
  if (present(key)) searches.push(semanticScholar(config, fetcher, query, key));
  const settled = await Promise.allSettled(searches);
  const lists = settled.flatMap((outcome) =>
    outcome.status === 'fulfilled' ? [outcome.value] : [],
  );
  if (lists.length === 0) {
    throw new ToolError('The literature services are unreachable. Try again later.');
  }
  const merged = new Map<string, LiteratureResult>();
  for (let rank = 0; rank < PER_SERVICE; rank += 1) {
    for (const list of lists) {
      const result = list[rank];
      if (result === undefined || result.title === '') continue;
      const id = identity(result);
      const existing = merged.get(id);
      if (existing === undefined) {
        merged.set(id, result);
      } else {
        // Same work from two services: keep the identifiers either one knows.
        merged.set(id, {
          ...existing,
          doi: existing.doi ?? result.doi,
          arxivId: existing.arxivId ?? result.arxivId,
        });
      }
    }
  }
  return [...merged.values()].slice(0, MAX_RESULTS);
}
