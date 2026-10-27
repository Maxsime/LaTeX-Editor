import { describe, expect, it } from 'vitest';
import { readConfig } from '../config.js';
import { searchLiterature } from './literature.js';

const config = readConfig({
  DATABASE_URL: 'postgres://x@localhost/x',
  VALKEY_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_BUCKET: 'galley-test',
  CROSSREF_URL: 'http://crossref.test',
  ARXIV_URL: 'http://arxiv.test',
  OPENALEX_URL: 'http://openalex.test',
});

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
<entry><id>http://arxiv.org/abs/1706.03762v7</id><title>Attention Is All You Need</title><published>2017-06-12T00:00:00Z</published>
<author><name>Ashish Vaswani</name></author><arxiv:doi>10.48550/arXiv.1706.03762</arxiv:doi></entry></feed>`;

function answering(routes: Record<string, string | null>): typeof fetch {
  return (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = routes[url.host];
    if (body === undefined || body === null) return Promise.reject(new Error('offline'));
    return Promise.resolve(new Response(body, { status: 200 }));
  };
}

describe('searchLiterature', () => {
  it('merges the services by identifier', async () => {
    const results = await searchLiterature(
      config,
      answering({
        'crossref.test': JSON.stringify({
          message: {
            items: [
              {
                DOI: '10.48550/arXiv.1706.03762',
                title: ['Attention Is All You Need'],
                author: [{ given: 'Ashish', family: 'Vaswani' }],
                issued: { 'date-parts': [[2017]] },
              },
            ],
          },
        }),
        'arxiv.test': ATOM,
        'openalex.test': JSON.stringify({
          results: [
            {
              doi: 'https://doi.org/10.1145/361219.361220',
              title: 'Another paper',
              publication_year: 1975,
              authorships: [{ author: { display_name: 'A. Author' } }],
              primary_location: { source: { display_name: 'CACM' } },
            },
          ],
        }),
      }),
      'attention',
    );
    expect(results).toEqual([
      {
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani'],
        year: 2017,
        doi: '10.48550/arXiv.1706.03762',
        arxivId: '1706.03762',
        venue: null,
      },
      {
        title: 'Another paper',
        authors: ['A. Author'],
        year: 1975,
        doi: '10.1145/361219.361220',
        arxivId: null,
        venue: 'CACM',
      },
    ]);
  });

  it('gets by with one service and fails when none answers', async () => {
    expect(await searchLiterature(config, answering({ 'arxiv.test': ATOM }), 'x')).toHaveLength(1);
    await expect(searchLiterature(config, answering({}), 'x')).rejects.toThrow(/unreachable/);
  });
});
