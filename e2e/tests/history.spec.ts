import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Page, test } from '@playwright/test';
import { createProject, editor, open, synced, upload } from '../editing.js';
import { createAccount, signIn } from '../instance.js';
import { baseURL } from '../support.js';

const exec = promisify(execFile);

const SOURCE = '\\documentclass{article}\n\\begin{document}\nPremière version.\n\\end{document}\n';

let scratch: string;

test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'galley-e2e-git-'));
});

test.afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Runs the Git client, trusting the instance's local CA only. */
async function git(cwd: string, ...args: string[]) {
  const ca = join(process.env.GALLEY_CA_DIR ?? '', 'root.crt');
  try {
    const { stdout, stderr } = await exec('git', ['-c', `http.sslCAInfo=${ca}`, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: scratch,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Poste local',
        GIT_AUTHOR_EMAIL: 'local@example.org',
        GIT_COMMITTER_NAME: 'Poste local',
        GIT_COMMITTER_EMAIL: 'local@example.org',
        NO_PROXY: '*',
        no_proxy: '*',
      },
    });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

/** Creates a personal access token on the account page and returns it. */
async function createToken(page: Page): Promise<string> {
  await page.getByRole('link', { name: 'Mon compte' }).click();
  await page.getByLabel('Nom du jeton').fill('Tests de bout en bout');
  await page.getByRole('button', { name: 'Créer un jeton' }).click();
  const token = await page.getByLabel('Nouveau jeton').inputValue();
  await expect(page.getByRole('list', { name: 'Jetons actifs' })).toContainText(token.slice(-4));
  return token;
}

/** Text of the active editor. */
function editorText(page: Page): Promise<string> {
  return editor(page).evaluate((content) =>
    Array.from(content.querySelectorAll('.cm-line'), (line) => line.textContent).join('\n'),
  );
}

async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await synced(page);
}

test('a project is cloned, pushed to live, pulled and restored without losing history', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, createAccount('historien'));
  const token = await createToken(page);

  await page.goto('/projects');
  await createProject(page, 'Historique et Git');
  const projectId = /\/projects\/([^/?#]+)/.exec(page.url())?.[1] ?? '';
  await upload(page, { 'main.tex': SOURCE });
  await open(page, 'main.tex');

  // A1: clone, change locally, push; the open editor shows the change.
  const remote = `${baseURL.replace('://', `://moi:${token}@`)}/git/${projectId}`;
  const clone = await git(scratch, 'clone', remote, 'projet');
  expect(clone.ok, clone.output).toBe(true);
  const work = join(scratch, 'projet');
  expect(await readFile(join(work, 'main.tex'), 'utf8')).toBe(SOURCE);
  await writeFile(
    join(work, 'main.tex'),
    SOURCE.replace('Première version.', 'Première version.\nLigne envoyée par Git.'),
  );
  await git(work, 'commit', '-am', 'Depuis mon poste');
  const push = await git(work, 'push', 'origin', 'main');
  expect(push.ok, push.output).toBe(true);
  await expect(editor(page)).toContainText('Ligne envoyée par Git.');

  // A2: a change typed in the editor reaches git pull.
  await typeAtEnd(page, '\n% Tapé dans Galley');
  const pull = await git(work, 'pull', '--ff-only');
  expect(pull.ok, pull.output).toBe(true);
  expect(await readFile(join(work, 'main.tex'), 'utf8')).toContain('% Tapé dans Galley');

  // A push that does not start from the latest state is refused.
  await writeFile(join(work, 'notes.tex'), 'Pas à jour\n');
  await git(work, 'add', 'notes.tex');
  await git(work, 'commit', '-m', 'En retard');
  await typeAtEnd(page, '\n% Modifié entre-temps');
  const late = await git(work, 'push', 'origin', 'main');
  expect(late.ok).toBe(false);
  expect(late.output).toMatch(/fetch first|rejected/);
  await expect(page.getByRole('treeitem', { name: /^notes\.tex/ })).toHaveCount(0);

  // A3: name the current state, change it, then restore the named version.
  await page.getByRole('button', { name: 'Historique', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Historique du projet' });
  await dialog.getByRole('button', { name: "Nommer l'état actuel" }).click();
  await page.getByLabel('Nom de la version').fill('Avant la réécriture');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  const versions = dialog.getByRole('list', { name: 'Versions' });
  await expect(versions.getByRole('button', { name: /Avant la réécriture/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await editor(page).getByText('Ligne envoyée par Git.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Réécrite.');
  await synced(page);
  const before = await editorText(page);
  expect(before).toContain('Réécrite.');

  await page.getByRole('button', { name: 'Historique', exact: true }).click();
  await versions.getByRole('button', { name: /Avant la réécriture/ }).click();
  await dialog.getByRole('button', { name: 'Voir les différences' }).click();
  await expect(dialog.getByLabel('Différences de main.tex')).toContainText('Réécrite.');
  const count = await versions.getByRole('listitem').count();
  await dialog.getByRole('button', { name: 'Restaurer cette version' }).click();
  await page
    .getByRole('dialog', { name: 'Restaurer cette version' })
    .getByRole('button', { name: 'Restaurer' })
    .click();
  await expect(editor(page)).not.toContainText('Réécrite.');
  await expect(editor(page)).toContainText('Ligne envoyée par Git.');
  // Nothing was lost: the named version and the replaced state are both listed.
  // The periodic snapshots may add one more meanwhile.
  await expect.poll(() => versions.getByRole('listitem').count()).toBeGreaterThanOrEqual(count + 2);
  await expect(versions.getByRole('button', { name: /Avant la réécriture/ })).toBeVisible();
  await expect(versions.getByRole('button', { name: /^Restauration/ })).toBeVisible();
});
