import { crc32, deflateRawSync } from 'node:zlib';
import yauzl from 'yauzl';

/** One entry of a hand-built archive; every field can lie, which is the point. */
export interface RawEntry {
  name: string;
  data?: Buffer;
  deflate?: boolean;
  /** Unix mode bits, e.g. 0o120777 for a symbolic link. */
  unixMode?: number;
  /** Uncompressed size written in the headers instead of the real one. */
  declaredSize?: number;
}

/**
 * Writes a zip archive byte by byte. Archivers refuse to produce hostile
 * archives, so the tests build them by hand.
 */
export function buildZip(entries: readonly RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const body = entry.deflate === true ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const size = entry.declaredSize ?? data.length;
    const mode = entry.unixMode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644);
    const method = entry.deflate === true ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Reads every entry of an archive into memory: `{path: content}`, directories mapped to null. */
export async function readZip(buffer: Buffer): Promise<Map<string, Buffer | null>> {
  const zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true });
  const result = new Map<string, Buffer | null>();
  for await (const entry of zip.eachEntry()) {
    if (entry.fileName.endsWith('/')) {
      result.set(entry.fileName, null);
      continue;
    }
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    result.set(entry.fileName, Buffer.concat(chunks));
  }
  zip.close();
  return result;
}

/** Encodes a multipart/form-data body for `inject`. */
export function multipart(
  parts: readonly (
    { name: string; value: string } | { name: string; filename: string; data: Buffer }
  )[],
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----galley${String(Date.now())}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      'filename' in part
        ? `form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: application/octet-stream`
        : `form-data; name="${part.name}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n\r\n`));
    chunks.push('filename' in part ? part.data : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
