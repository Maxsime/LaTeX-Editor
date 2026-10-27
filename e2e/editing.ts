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
