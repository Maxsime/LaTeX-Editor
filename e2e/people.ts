import { type Browser, expect, type Page } from '@playwright/test';
import { createProject, editor, upload } from './editing.js';
import { type Account, createAccount, signIn } from './instance.js';

export const SOURCE =
  '\\documentclass{article}\n\\begin{document}\nLe paragraphe commun.\n\\end{document}\n';

export interface Participant {
  page: Page;
  account: Account;
}

/** A signed-in user in a browser context of their own. */
export async function participant(browser: Browser, name: string): Promise<Participant> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const account = createAccount(name);
  await signIn(page, account);
  return { page, account };
}

/** Creates a project holding `collab.tex` and returns its id and the file's id. */
export async function sharedProject(
  page: Page,
  name: string,
): Promise<{ projectId: string; fileId: string }> {
  await createProject(page, name);
  await upload(page, { 'collab.tex': SOURCE });
  const projectId = /\/projects\/([^/?#]+)/.exec(page.url())?.[1] ?? '';
  const node = page.getByRole('treeitem', { name: /^collab\.tex/ });
  const fileId = ((await node.getAttribute('id')) ?? '').replace(/^node-/, '');
  return { projectId, fileId };
}

export async function openShare(page: Page) {
  await page.getByRole('button', { name: 'Partager', exact: true }).click();
  return page.getByRole('dialog');
}

/** Creates a share link from the owner's dialog and returns its URL. */
export async function shareLink(page: Page, role: string): Promise<string> {
  const dialog = await openShare(page);
  await dialog.getByLabel('Rôle donné par le lien').selectOption({ label: role });
  await dialog.getByRole('button', { name: 'Créer un lien' }).click();
  const url = await dialog.getByLabel('Nouveau lien').inputValue();
  await dialog.getByRole('button', { name: 'Fermer' }).click();
  return url;
}

export async function joinThroughLink(page: Page, url: string, project: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('button', { name: 'Rejoindre le projet' }).click();
  await expect(page.getByRole('heading', { level: 1, name: project })).toBeVisible();
}

/** Text of the active editor, without the cursors and name tags of other people. */
export function editorText(page: Page): Promise<string> {
  return editor(page).evaluate((content) =>
    Array.from(content.querySelectorAll('.cm-line'), (line) => {
      const copy = line.cloneNode(true) as HTMLElement;
      for (const widget of copy.querySelectorAll('[class*="cm-ySelection"]')) widget.remove();
      return copy.textContent;
    }).join('\n'),
  );
}

/** Text of the file as the server stores it. */
export async function serverText(page: Page, projectId: string, fileId: string): Promise<string> {
  const response = await page.request.get(`/api/projects/${projectId}/files/${fileId}/content`);
  expect(response.ok()).toBe(true);
  return response.text();
}
