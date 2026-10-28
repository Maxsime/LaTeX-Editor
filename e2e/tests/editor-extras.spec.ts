import { expect, type Page, test } from '@playwright/test';
import {
  compileStatus,
  createProject,
  editor,
  open,
  pdfShown,
  synced,
  upload,
} from '../editing.js';
import { createAccount, signIn } from '../instance.js';
import { joinThroughLink, participant, sharedProject, shareLink } from '../people.js';

async function setMainFile(page: Page, name: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.ok(),
  );
  await page.getByLabel('Document principal').selectOption({ label: name });
  await saved;
}

const BIB = `@book{zola1885,
  year = {1885}, title = {Germinal}, author = {Zola, Émile}
}

@book{balzac1835,
  title = {Le Père Goriot},
  author = {Balzac, Honoré de},
  year = {1835},
}
`;

test.describe('editor and viewer extras', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await signIn(page, createAccount('extras'));
  });

  test('explains a common error under its log entry', async ({ page }) => {
    await createProject(page, 'Erreur expliquée');
    await upload(page, {
      'faute.tex':
        '\\documentclass{article}\n\\begin{document}\nIci \\commandeinconnue{}.\n\\end{document}\n',
    });
    await setMainFile(page, 'faute.tex');
    await page.keyboard.press('ControlOrMeta+Enter');
    const log = page.getByRole('button', { name: /^Journal \(1 erreur/ });
    await expect(log).toBeVisible({ timeout: 60_000 });
    await log.click();
    await expect(page.getByTestId('explanation')).toContainText(
      'La commande \\commandeinconnue n’existe pas',
    );
  });

  test('sorts and formats a .bib file as an undoable edit', async ({ page }) => {
    await createProject(page, 'Bibliographie triée');
    await upload(page, { 'refs.bib': BIB });
    await open(page, 'refs.bib');
    await page.getByRole('button', { name: 'Trier et formater' }).click();
    await page.getByLabel('Par premier auteur').check();
    await page.getByRole('button', { name: 'Appliquer' }).click();
    await synced(page);
    const text = editor(page);
    await expect(text).toContainText('@book{balzac1835,');
    const content = (await text.textContent()) ?? '';
    expect(content.indexOf('balzac1835')).toBeLessThan(content.indexOf('zola1885'));
    expect(content).toContain('author = {Zola, Émile},');

    await text.click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(text).toContainText('year = {1885}, title = {Germinal}');
  });

  test('offers Vim key bindings and the visual editor', async ({ page }) => {
    await createProject(page, 'Clavier et visuel');
    await upload(page, {
      'visuel.tex':
        '\\section{Introduction}\nDu texte \\emph{important} et $x^2$.\n\nDernière ligne.\n',
    });
    await open(page, 'visuel.tex');

    await page.getByLabel('Raccourcis').selectOption('vim');
    await expect(page.locator('.cm-vim-panel')).toBeVisible();
    await editor(page).getByText('Dernière ligne.').click();
    await page.keyboard.press('Escape');
    await page.keyboard.type('dd');
    await expect(editor(page)).not.toContainText('Dernière ligne.');
    await page.keyboard.type('u');
    await expect(editor(page)).toContainText('Dernière ligne.');
    await page.getByLabel('Raccourcis').selectOption('default');
    await expect(page.locator('.cm-vim-panel')).toHaveCount(0);

    await page.getByRole('button', { name: 'Visuel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Visuel', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The cursor is on the last line: the others are drawn.
    await expect(editor(page).locator('.cm-visual-h2')).toHaveText('Introduction');
    await expect(editor(page).locator('.cm-visual-italic')).toHaveText('important');
    await expect(editor(page).getByTestId('visual-math').locator('.katex')).toBeVisible();
    await expect(editor(page)).not.toContainText('\\section{');
  });

  test('shows the PDF in dark mode and in a window of its own', async ({ page }) => {
    await createProject(page, 'Fenêtre PDF');
    await compileStatus(page, 'success');
    await pdfShown(page);

    const dark = page.getByRole('button', { name: 'Mode sombre' });
    await dark.click();
    await expect(dark).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.pdf-dark')).toHaveCount(1);

    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Détacher' }).click();
    const popup = await popupPromise;
    await expect(popup.getByTestId('pdf-viewer')).not.toHaveAttribute('data-pages', '0', {
      timeout: 30_000,
    });
    await expect(popup.getByTestId('pdf-viewer')).not.toHaveAttribute('data-url', '');
    await expect(page.getByRole('button', { name: 'Rattacher le PDF' })).toBeVisible();

    const closed = popup.waitForEvent('close');
    await page.getByRole('button', { name: 'Rattacher le PDF' }).click();
    await closed;
    await expect(page.getByTestId('pdf-viewer')).toBeVisible();
  });
});

test('follows a collaborator from file to file until the reader acts', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await participant(browser, 'guide');
  const guest = await participant(browser, 'suiveur');
  await sharedProject(owner.page, 'Visite guidée');
  await upload(owner.page, { 'annexe.tex': 'Une annexe.\n' });
  const url = await shareLink(owner.page, 'Éditeur');
  await joinThroughLink(guest.page, url, 'Visite guidée');
  await open(owner.page, 'collab.tex');

  const badge = guest.page.getByRole('button', { name: /guide : collab\.tex/ });
  await badge.click();
  await expect(guest.page.getByRole('status').filter({ hasText: 'Vous suivez' })).toBeVisible();
  await expect(guest.page.getByRole('tab', { name: /collab\.tex/, selected: true })).toBeVisible();

  await open(owner.page, 'annexe.tex');
  await expect(guest.page.getByRole('tab', { name: /annexe\.tex/, selected: true })).toBeVisible();

  // A click in the editor ends the visit.
  await editor(guest.page).click();
  await expect(guest.page.getByRole('status').filter({ hasText: 'Vous suivez' })).toHaveCount(0);
  await open(owner.page, 'collab.tex');
  await expect(guest.page.getByRole('tab', { name: /annexe\.tex/, selected: true })).toBeVisible();
});
