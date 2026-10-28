import { expect, type Page, test } from '@playwright/test';
import { createProject, upload } from '../editing.js';
import { createAccount, signIn } from '../instance.js';

/** Creates a personal access token on the account page and returns it. */
async function createToken(page: Page): Promise<string> {
  await page.getByRole('link', { name: 'Mon compte' }).click();
  await page.getByLabel('Nom du jeton').fill('Synchronisation');
  await page.getByRole('button', { name: 'Créer un jeton' }).click();
  return page.getByLabel('Nouveau jeton').inputValue();
}

function projectId(page: Page): string {
  return /\/projects\/([^/?#]+)/.exec(page.url())?.[1] ?? '';
}

test('a project is linked to a repository, pulled from and pushed to', async ({ page }) => {
  // CI lets the API reach its own Git endpoint as a remote (.github/workflows/ci.yml).
  test.skip(
    !(process.env.GIT_SYNC_HOSTS ?? '').includes('127.0.0.1:3000'),
    'no local remote allowed',
  );
  await signIn(page, createAccount('synchro'));
  const token = await createToken(page);
  await page.goto('/projects');
  await createProject(page, 'Dépôt distant');
  const upstream = projectId(page);
  await upload(page, { 'distant.tex': 'Texte du dépôt.\n' });

  await page.goto('/projects');
  await createProject(page, 'Thèse synchronisée');
  await page.getByRole('button', { name: 'Historique', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Historique du projet' });
  await dialog.getByLabel('Adresse du dépôt').fill(`http://127.0.0.1:3000/git/${upstream}`);
  await dialog.getByLabel("Jeton d'accès").fill(token);
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dialog.getByText(`…${token.slice(-4)}`)).toBeVisible();
  await expect(dialog.getByText('Jamais synchronisé.')).toBeVisible();

  await dialog.getByRole('button', { name: 'Tirer' }).click();
  await expect(dialog.getByRole('status')).toHaveText(
    'Modifications du dépôt distant fusionnées avec celles du projet.',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('treeitem', { name: /^distant\.tex/ })).toBeVisible();

  await upload(page, { 'local.tex': 'Texte du projet.\n' });
  await page.getByRole('button', { name: 'Historique', exact: true }).click();
  await dialog.getByRole('button', { name: 'Pousser' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Projet poussé sur le dépôt distant.');
  await expect(dialog.getByText(/Dernière synchronisation/)).toBeVisible();

  const pushed = await page.request.get(
    `/api/projects/${upstream}/history/current/content?path=local.tex`,
  );
  expect(await pushed.text()).toBe('Texte du projet.\n');
});
