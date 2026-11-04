// Writes .br, .zst and .gz siblings of the built assets, for Caddy's `precompressed`
// option: the strongest levels are affordable once at build time, never per request.
// Usage: node scripts/precompress.mjs <directory>
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants, brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib';

const COMPRESSIBLE = /\.(?:js|mjs|css|svg|json|ttf|txt|wasm|bcmap|pfb|xml)$/;
// Below this size the saving does not pay for a second request header or a file.
const MIN_BYTES = 1024;

const encoders = [
  [
    '.br',
    (data) =>
      brotliCompressSync(data, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      }),
  ],
  [
    '.zst',
    (data) => zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }),
  ],
  ['.gz', (data) => gzipSync(data, { level: constants.Z_BEST_COMPRESSION })],
];

const root = process.argv[2];
if (!root) {
  process.stderr.write('usage: precompress.mjs <directory>\n');
  process.exit(2);
}

let before = 0;
let after = 0;
for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !COMPRESSIBLE.test(entry.name)) continue;
  const path = join(entry.parentPath, entry.name);
  const data = await readFile(path);
  if (data.length < MIN_BYTES) continue;
  before += data.length;
  let best = data.length;
  for (const [extension, encode] of encoders) {
    const encoded = encode(data);
    // A sibling larger than the original would only waste space: Caddy serves the file.
    if (encoded.length >= data.length) continue;
    await writeFile(path + extension, encoded);
    best = Math.min(best, encoded.length);
  }
  after += best;
}
process.stdout.write(
  `precompressed ${(before / 1024).toFixed(0)} kB of assets to ${(after / 1024).toFixed(0)} kB\n`,
);
