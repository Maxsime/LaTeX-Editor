import { expect, type Locator, type Page } from '@playwright/test';

/** Content area of the editor shown in the active tab. */
export function editor(page: Page): Locator {
  return page.locator('.cm-editor:visible .cm-content');
}

/** Waits until the server acknowledged every change of the active tab. */
export async function synced(page: Page): Promise<void> {
  await expect(page.locator('[role="tab"][aria-selected="true"] [data-status]')).toHaveAttribute(
    'data-status',
    'saved',
  );
}

export async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Nouveau projet' }).click();
  await page.getByLabel('Nom du projet').fill(name);
  await page.getByRole('button', { name: 'Créer' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

export async function upload(page: Page, files: Record<string, string>): Promise<void> {
  await page.getByTestId('upload-files').setInputFiles(
    Object.entries(files).map(([name, content]) => ({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from(content),
    })),
  );
  for (const name of Object.keys(files)) {
    await expect(
      page.getByRole('treeitem', { name: new RegExp(name.replace('.', '\\.')) }),
    ).toBeVisible();
  }
}

export async function open(page: Page, name: string): Promise<void> {
  await page.getByRole('treeitem', { name: new RegExp(`^${name.replace('.', '\\.')}`) }).click();
  await synced(page);
}

/** Imports a zip as a new project, through the dashboard's import button. */
export async function importZip(page: Page, name: string, data: Buffer): Promise<void> {
  await page
    .getByTestId('import-input')
    .setInputFiles({ name, mimeType: 'application/zip', buffer: data });
}

/** The PDF viewer once it shows a PDF with at least one page. */
export async function pdfShown(page: Page): Promise<string> {
  const viewer = page.getByTestId('pdf-viewer');
  await expect(viewer).not.toHaveAttribute('data-url', '', { timeout: 60_000 });
  await expect(viewer).not.toHaveAttribute('data-pages', '0');
  return (await viewer.getAttribute('data-url')) ?? '';
}

export async function compileStatus(page: Page, status: string, timeout = 60_000): Promise<void> {
  await expect(page.getByTestId('compile-status')).toHaveAttribute('data-status', status, {
    timeout,
  });
}

/**
 * Sends a Yjs update over a WebSocket of its own, with the page's session, as
 * a hand-crafted client would. Returns how many messages the server sent back.
 */
export function sendRawUpdate(
  page: Page,
  documentName: string,
  update: readonly number[],
): Promise<number> {
  return page.evaluate(
    async ({ documentName: name, update: bytes }) => {
      const encoder = new TextEncoder();
      const varUint = (value: number): number[] => {
        const out: number[] = [];
        let rest = value;
        while (rest > 0x7f) {
          out.push((rest & 0x7f) | 0x80);
          rest >>>= 7;
        }
        out.push(rest);
        return out;
      };
      const varBytes = (data: ArrayLike<number>): number[] => [
        ...varUint(data.length),
        ...Array.from(data),
      ];
      const varString = (text: string): number[] => varBytes(encoder.encode(text));
      // Hocuspocus framing: document name, message type, then the payload.
      const auth = [...varString(name), 2, 0, ...varString(''), ...varString('4.7.1')];
      const sync = [...varString(name), 0, 2, ...varBytes(bytes)];
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/collab`);
      socket.binaryType = 'arraybuffer';
      let received = 0;
      await new Promise<void>((resolve, reject) => {
        socket.onerror = () => {
          reject(new Error('socket error'));
        };
        socket.onopen = () => {
          socket.send(new Uint8Array(auth));
        };
        socket.onmessage = () => {
          received += 1;
          if (received === 1) {
            socket.send(new Uint8Array(sync));
            setTimeout(resolve, 1500);
          }
        };
      });
      socket.close();
      return received;
    },
    { documentName, update: [...update] },
  );
}
