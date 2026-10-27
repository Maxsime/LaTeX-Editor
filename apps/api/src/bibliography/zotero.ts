import { ApiError, type ZoteroItem } from '@galley/shared';
import * as z from 'zod/mini';
import { type Fetch, fetchText, parseJson, userAgent, withSlash } from './sources.js';

const ITEMS_PAGE = 25;

function headers(apiKey: string): Record<string, string> {
  return {
    'zotero-api-key': apiKey,
    'zotero-api-version': '3',
    'user-agent': userAgent(),
  };
}

/** The Zotero account a key belongs to. */
export interface ZoteroKeyOwner {
  userId: string;
  username: string;
}

/** Asks Zotero whose key this is; a key Zotero does not know is IDENTIFIER_INVALID. */
export async function verifyZoteroKey(
  base: string,
  fetcher: Fetch,
  apiKey: string,
): Promise<ZoteroKeyOwner> {
  // Zotero answers 403 to an unknown or revoked key.
  const body = await fetchText(
    fetcher,
    new URL('keys/current', withSlash(base)),
    headers(apiKey),
    [403, 404],
  );
  const parsed =
    body === null
      ? null
      : parseJson(
          body,
          z.object({ userID: z.optional(z.number()), username: z.optional(z.string()) }),
        );
  if (parsed?.userID === undefined) {
    throw new ApiError('IDENTIFIER_INVALID', 'unknown Zotero key');
  }
  return { userId: String(parsed.userID), username: parsed.username ?? String(parsed.userID) };
}

const zoteroItems = z.array(
  z.object({
    key: z.optional(z.string()),
    data: z.optional(
      z.object({
        itemType: z.optional(z.string()),
        title: z.optional(z.string()),
        creators: z.optional(
          z.array(
            z.object({
              creatorType: z.optional(z.string()),
              lastName: z.optional(z.string()),
              name: z.optional(z.string()),
            }),
          ),
        ),
        date: z.optional(z.string()),
      }),
    ),
  }),
);

/** Top-level items of the library matching `query` (title, creator, year), most recent first. */
export async function searchZotero(
  base: string,
  fetcher: Fetch,
  account: { userId: string; apiKey: string },
  query: string,
): Promise<ZoteroItem[]> {
  const url = new URL(`users/${encodeURIComponent(account.userId)}/items/top`, withSlash(base));
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(ITEMS_PAGE));
  url.searchParams.set('sort', 'dateModified');
  url.searchParams.set('direction', 'desc');
  url.searchParams.set('itemType', '-attachment || note');
  if (query !== '') {
    url.searchParams.set('q', query);
    url.searchParams.set('qmode', 'titleCreatorYear');
  }
  const body = await fetchText(fetcher, url, headers(account.apiKey));
  const items = body === null ? [] : parseJson(body, zoteroItems);
  return items.flatMap((item): ZoteroItem[] => {
    if (item.key === undefined || item.data === undefined) return [];
    const authors = (item.data.creators ?? [])
      .filter((creator) => creator.creatorType === undefined || creator.creatorType === 'author')
      .map((creator) => creator.lastName ?? creator.name ?? '')
      .filter((name) => name !== '');
    return [
      {
        key: item.key,
        type: item.data.itemType ?? 'document',
        title: item.data.title ?? '',
        authors,
        year: /\d{4}/.exec(item.data.date ?? '')?.[0] ?? null,
      },
    ];
  });
}

/** BibLaTeX export of the given items, as Zotero writes it. */
export async function exportZotero(
  base: string,
  fetcher: Fetch,
  account: { userId: string; apiKey: string },
  itemKeys: readonly string[],
): Promise<string> {
  const url = new URL(`users/${encodeURIComponent(account.userId)}/items`, withSlash(base));
  url.searchParams.set('itemKey', itemKeys.join(','));
  url.searchParams.set('format', 'biblatex');
  const body = await fetchText(fetcher, url, headers(account.apiKey));
  if (body === null || body.trim() === '') throw new ApiError('REFERENCE_NOT_FOUND');
  return body;
}
