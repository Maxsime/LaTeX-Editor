// Pre-receive hook of Galley repositories, run by `git receive-pack` during a
// push. The API decides; this script only hands it the updates and relays its
// answer, which Git shows the user as "remote:" lines.
/* eslint-disable no-console -- standard error is how a hook talks to the user. */
import { readFileSync } from 'node:fs';

const updates = readFileSync(0, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => {
    const [oldId, newId, ref] = line.split(' ');
    return { oldId, newId, ref };
  });

let response;
try {
  response = await fetch(process.env.GALLEY_HOOK_URL ?? '', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-galley-push': process.env.GALLEY_PUSH_TOKEN ?? '',
    },
    body: JSON.stringify({ updates, objectDirectory: process.env.GIT_OBJECT_DIRECTORY ?? null }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
} catch {
  console.error('Galley: push service unavailable, try again later.');
  process.exit(1);
}
const body = await response.json().catch(() => ({}));
if (typeof body.message === 'string') console.error(body.message);
process.exit(response.ok ? 0 : 1);
