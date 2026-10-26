import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { createAccount, hostileZip, referenceArchive, signIn, zipDigests } from '../instance.js';

async function expandAll(page: Page): Promise<void> {
  const collapsed = page.locator('[role="treeitem"][aria-expanded="false"]');
  while ((await collapsed.count()) > 0) {
    await collapsed.first().click();
  }
}

async function treePaths(page: Page): Promise<string[]> {
  // An open dialog hides the tree from the accessibility tree; wait for the action to finish.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expandAll(page);
  const paths: string[] = [];
  for (const item of await page.getByRole('treeitem').all()) {
    paths.push((await item.getAttribute('data-path')) ?? '');
  }
  return paths.sort();
}

async function importZip(page: Page, name: string, data: Buffer): Promise<void> {
  await page
    .getByTestId('import-input')
    .setInputFiles({ name, mimeType: 'application/zip', buffer: data });
}

test.describe('projects and files', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, createAccount('user'));
  });

  test('A1 and A2: imports a project zip identically and exports it back', async ({ page }) => {
    const reference = await readFile(referenceArchive);
    const original = await zipDigests(referenceArchive);

    await importZip(page, 'Rapport de projet.zip', reference);
    await expect(page.getByRole('heading', { level: 1, name: 'Rapport de projet' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText(
      "chapitres/ancien-latin1.tex n'est pas en UTF-8",
    );
    const expected = Object.keys(original)
      .map((path) => path.replace(/\/$/, ''))
      .sort();
    expect(await treePaths(page)).toEqual(expected);
    await expect(page.getByRole('treeitem', { name: /main\.tex/ })).toContainText('principal');
    await expect(page.getByLabel('Document principal')).toHaveValue(/.+/);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Exporter (zip)' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Rapport de projet.zip');
    expect(await zipDigests(await download.path())).toEqual(original);
  });

  test('A3: refuses a malicious archive with a clear message', async ({ page }) => {
    await importZip(page, 'evil.zip', hostileZip('../../etc/evil.tex'));
    await expect(page.getByRole('alert')).toHaveText(
      "L'archive contient un chemin qui sort du projet : elle est refusée.",
    );
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByTestId('project-row')).toHaveCount(0);
  });

  test('creates a project and manages its files', async ({ page }) => {
    await page.getByRole('button', { name: 'Nouveau projet' }).click();
    await page.getByLabel('Nom du projet').fill('Mémoire');
    await page.getByLabel('Modèle').selectOption('article');
    await page.getByRole('button', { name: 'Créer' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Mémoire' })).toBeVisible();
    expect(await treePaths(page)).toEqual(['main.tex', 'references.bib']);

    await page.getByRole('treeitem', { name: /main\.tex/ }).click();
    await expect(page.locator('.cm-editor:visible .cm-content')).toContainText(
      '\\documentclass[11pt,a4paper]{article}',
    );

    // Folder, upload into it, rename, move with the keyboard dialog, drag and drop, delete.
    await page.getByRole('treeitem', { name: /references\.bib/ }).click();
    await page.getByRole('button', { name: 'Nouveau dossier' }).click();
    await page.getByLabel('Nom du dossier').fill('figures');
    await page.getByRole('button', { name: 'Créer' }).click();
    await expect(page.getByRole('treeitem', { name: /figures/ })).toBeVisible();

    await page.getByRole('treeitem', { name: /figures/ }).click();
    await page.getByTestId('upload-files').setInputFiles([
      { name: 'plot.png', mimeType: 'image/png', buffer: tinyPng() },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes\n') },
    ]);
    await expect(page.getByRole('treeitem', { name: /plot\.png/ })).toBeVisible();
    expect(await treePaths(page)).toEqual([
      'figures',
      'figures/notes.txt',
      'figures/plot.png',
      'main.tex',
      'references.bib',
    ]);
    await page.getByRole('treeitem', { name: /plot\.png/ }).click();
    await expect(page.getByRole('img', { name: 'plot.png' })).toBeVisible();

    await page.getByRole('treeitem', { name: /notes\.txt/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Renommer' }).click();
    await page.getByLabel('Nouveau nom').fill('lisez-moi.txt');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('treeitem', { name: /lisez-moi\.txt/ })).toBeVisible();

    await page.getByRole('button', { name: 'Actions sur lisez-moi.txt' }).click();
    await page.getByRole('menuitem', { name: 'Déplacer vers…' }).click();
    await page.getByRole('button', { name: 'Racine du projet' }).click();
    expect(await treePaths(page)).toContain('lisez-moi.txt');

    await page
      .getByRole('treeitem', { name: /lisez-moi\.txt/ })
      .dragTo(page.getByRole('treeitem', { name: /figures/ }));
    expect(await treePaths(page)).toContain('figures/lisez-moi.txt');

    await page.getByRole('treeitem', { name: /figures/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Supprimer' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Supprimer' }).click();
    expect(await treePaths(page)).toEqual(['main.tex', 'references.bib']);
  });

  test('archives, trashes and restores from the dashboard', async ({ page }) => {
    for (const name of ['Alpha', 'Bêta']) {
      await page.getByRole('button', { name: 'Nouveau projet' }).click();
      await page.getByLabel('Nom du projet').fill(name);
      await page.getByRole('button', { name: 'Créer' }).click();
      await page.getByRole('link', { name: 'Tous les projets' }).click();
    }
    const rows = page.getByTestId('project-row');
    await expect(rows).toHaveCount(2);

    await page.getByLabel('Rechercher un projet').fill('bêta');
    await expect(rows).toHaveCount(1);
    await page.getByLabel('Rechercher un projet').fill('');

    await page.getByLabel('Sélectionner Alpha').check();
    await page.getByRole('button', { name: 'Archiver' }).click();
    await expect(rows).toHaveCount(1);
    await page.getByRole('radio', { name: 'Archivés' }).click();
    await expect(rows).toHaveText([/Alpha/]);

    await page.getByLabel('Sélectionner Alpha').check();
    await page.getByRole('button', { name: 'Mettre à la corbeille' }).click();
    await page.getByRole('radio', { name: 'Corbeille' }).click();
    await expect(page.getByText('supprimés définitivement après 30 jours')).toBeVisible();
    await expect(rows).toHaveText([/Alpha/]);
    await page.getByLabel('Sélectionner Alpha').check();
    await page.getByRole('button', { name: 'Restaurer' }).click();
    await expect(rows).toHaveCount(0);
    await page.getByRole('radio', { name: 'Archivés' }).click();
    await expect(rows).toHaveText([/Alpha/]);
  });

  test('tags projects and filters by tag', async ({ page }) => {
    await page.getByRole('button', { name: 'Nouveau projet' }).click();
    await page.getByLabel('Nom du projet').fill('Stage');
    await page.getByRole('button', { name: 'Créer' }).click();
    await page.getByRole('link', { name: 'Tous les projets' }).click();
    await page.getByLabel("Nom de l'étiquette").fill('Polytech');
    await page.getByRole('button', { name: 'Nouvelle étiquette' }).click();
    await page.getByRole('button', { name: 'Étiquettes du projet : Stage' }).click();
    await page.getByRole('menuitemcheckbox', { name: /Polytech/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('project-row')).toContainText('Polytech');
    await page.getByRole('combobox', { name: 'Étiquettes' }).selectOption({ label: 'Polytech' });
    await expect(page.getByTestId('project-row')).toHaveText([/Stage/]);
  });
});

/** 1×1 PNG. */
function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/2a0D4wAAAABJRU5ErkJggg==',
    'base64',
  );
}
