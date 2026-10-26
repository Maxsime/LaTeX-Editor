import * as z from 'zod/mini';
import { fileId } from './files.js';

export const outlineEntry = z.object({
  fileId,
  path: z.string(),
  line: z.number(),
  level: z.string(),
  /** 0 for parts, 2 for sections; frames sit at 4. */
  depth: z.number(),
  title: z.string(),
  starred: z.boolean(),
});
export type OutlineEntry = z.infer<typeof outlineEntry>;

export const outlineResponse = z.object({
  mainFileId: z.nullable(fileId),
  entries: z.array(outlineEntry),
});
export type OutlineResponse = z.infer<typeof outlineResponse>;

const located = { fileId, line: z.number() };

export const projectIndexResponse = z.object({
  commands: z.array(
    z.object({ name: z.string(), args: z.number(), optional: z.boolean(), ...located }),
  ),
  environments: z.array(z.object({ name: z.string(), args: z.number(), ...located })),
  labels: z.array(z.object({ name: z.string(), ...located })),
});
export type ProjectIndexResponse = z.infer<typeof projectIndexResponse>;

/** Query-string flag: absent or anything but "true" is false. */
const flag = z.pipe(
  z.optional(z.string()),
  z.transform((value) => value === 'true'),
);

export const MAX_SEARCH_QUERY = 500;
/** Matches returned by one search; the response says when more exist. */
export const MAX_SEARCH_RESULTS = 1000;

export const searchQuery = z.object({
  q: z.string().check(z.minLength(1), z.maxLength(MAX_SEARCH_QUERY)),
  regex: flag,
  caseSensitive: flag,
  wholeWord: flag,
});
export type SearchQuery = z.infer<typeof searchQuery>;

export const searchMatch = z.object({
  fileId,
  path: z.string(),
  /** 1-based line and UTF-16 column of the match start. */
  line: z.number(),
  column: z.number(),
  length: z.number(),
  /** The line holding the match, shortened around it. */
  preview: z.string(),
  /** Offset of the match inside `preview`. */
  previewOffset: z.number(),
});
export type SearchMatch = z.infer<typeof searchMatch>;

export const searchResponse = z.object({
  matches: z.array(searchMatch),
  truncated: z.boolean(),
});
export type SearchResponse = z.infer<typeof searchResponse>;

export const replaceRequest = z.object({
  q: z.string().check(z.minLength(1), z.maxLength(MAX_SEARCH_QUERY)),
  regex: z._default(z.boolean(), false),
  caseSensitive: z._default(z.boolean(), false),
  wholeWord: z._default(z.boolean(), false),
  /** With `regex`, `$1` refers to a capture group; otherwise inserted as is. */
  replacement: z.string().check(z.maxLength(10_000)),
  /** Limits the replacement to these files; all text files otherwise. */
  fileIds: z.optional(z.array(fileId).check(z.maxLength(10_000))),
});
export type ReplaceRequest = z.infer<typeof replaceRequest>;

export const replaceResponse = z.object({
  files: z.number(),
  replacements: z.number(),
});
export type ReplaceResponse = z.infer<typeof replaceResponse>;
