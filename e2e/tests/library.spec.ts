import { expect, type Page, test } from '@playwright/test';
import { compileStatus, createProject, editor, pdfShown, upload } from '../editing.js';
import { createAccount, signIn } from '../instance.js';

async function treeNames(page: Page): Promise<string[]> {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const names: string[] = [];
  for (const item of await page.getByRole('treeitem').all()) {
    names.push((await item.getAttribute('data-path')) ?? '');
  }
  return names.sort();
}

async function newProject(page: Page, name: string, template: string): Promise<void> {
  await page.getByRole('button', { name: 'Nouveau projet' }).click();
  await page.getByLabel('Nom du projet').fill(name);
  await page.getByLabel('Modèle').selectOption({ label: template });
  await page.getByRole('button', { name: 'Créer' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

async function dashboard(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Tous les projets' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projets' })).toBeVisible();
}

test.describe('project library', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await signIn(page, createAccount('library'));
  });

  test('duplicates a project and starts a new one from a saved template', async ({ page }) => {
    await newProject(page, 'Source', 'Article avec bibliographie');
    await expect.poll(() => treeNames(page)).toEqual(['main.tex', 'references.bib']);
    await dashboard(page);

    await page.getByRole('button', { name: 'Actions sur Source' }).click();
    await page.getByRole('menuitem', { name: 'Enregistrer comme modèle' }).click();
    await page.getByLabel('Nom du modèle').fill('Mon gabarit');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('status')).toContainText('Modèle enregistré');
    await page.getByRole('button', { name: 'Fermer' }).click();

    await page.getByRole('button', { name: 'Actions sur Source' }).click();
    await page.getByRole('menuitem', { name: 'Dupliquer' }).click();
    await expect(page.getByLabel('Nom de la copie')).toHaveValue('Source (copie)');
    await page.getByRole('button', { name: 'Dupliquer' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Source (copie)' })).toBeVisible();
    await expect.poll(() => treeNames(page)).toEqual(['main.tex', 'references.bib']);
    await dashboard(page);

    await newProject(page, 'Depuis le modèle', 'Mon gabarit');
    await expect.poll(() => treeNames(page)).toEqual(['main.tex', 'references.bib']);
    await expect(page.getByLabel('Document principal')).not.toHaveValue('');

    await page.getByRole('link', { name: 'Mon compte' }).click();
    const templates = page.getByRole('region', { name: 'Mes modèles' });
    await expect(templates.getByText('Mon gabarit')).toBeVisible();
    await templates.getByRole('button', { name: 'Supprimer le modèle' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Supprimer le modèle' }).click();
    await expect(templates.getByText('Aucun modèle enregistré.')).toBeVisible();
  });

  test('links and copies files from another project', async ({ page }) => {
    await newProject(page, 'Bibliothèque', 'Article avec bibliographie');
    await dashboard(page);
    await createProject(page, 'Thèse');

    await page.getByRole('button', { name: 'Fichier lié…' }).click();
    await page.getByLabel('Fichier d’un autre projet').check();
    await page.getByLabel('Projet source').selectOption({ label: 'Bibliothèque' });
    await page
      .getByRole('combobox', { name: 'Fichier', exact: true })
      .selectOption({ label: 'references.bib' });
    await page.getByLabel('Nom dans ce projet').fill('commun.bib');
    await page.getByRole('button', { name: 'Ajouter' }).click();
    const linked = page.getByRole('treeitem', { name: /^commun\.bib/ });
    await expect(linked).toContainText('lié');

    // A linked file opens read-only, with the reason.
    await linked.click();
    await expect(page.getByRole('note')).toContainText(
      'Fichier lié à Bibliothèque › references.bib',
    );
    await expect(editor(page)).toHaveAttribute('contenteditable', 'false');

    await linked.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rompre le lien' }).click();
    await expect(linked).not.toContainText('lié');

    await page.getByRole('button', { name: 'Copier depuis un projet…' }).click();
    await page.getByLabel('Projet source').selectOption({ label: 'Bibliothèque' });
    await page.getByLabel('references.bib').check();
    await page.getByRole('button', { name: 'Copier 1 élément' }).click();
    await expect.poll(() => treeNames(page)).toEqual(['commun.bib', 'main.tex', 'references.bib']);
  });

  test('compiles a project against the personal texmf tree', async ({ page }) => {
    await page.getByRole('link', { name: 'Mon compte' }).click();
    await page.getByRole('button', { name: 'Ouvrir mon texmf' }).click();
    await expect(page.getByRole('note')).toContainText('arborescence texmf personnelle');
    await expect(page.getByRole('button', { name: 'Partager' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Compilation et aperçu' })).toBeHidden();
    await upload(page, {
      'perso.sty': '\\ProvidesPackage{perso}\n\\newcommand{\\perso}{Texte venu du texmf}\n',
    });

    await dashboard(page);
    // The texmf tree is not a project of the list.
    await expect(page.getByTestId('project-row')).toHaveCount(0);
    await createProject(page, 'Avec texmf');
    await upload(page, {
      'perso.tex':
        '\\documentclass{article}\n\\usepackage{perso}\n\\begin{document}\n\\perso\n\\end{document}\n',
    });
    const saved = page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.ok(),
    );
    await page.getByLabel('Document principal').selectOption({ label: 'perso.tex' });
    await saved;
    await page.keyboard.press('ControlOrMeta+Enter');
    await compileStatus(page, 'success');
    await pdfShown(page);
  });
});
