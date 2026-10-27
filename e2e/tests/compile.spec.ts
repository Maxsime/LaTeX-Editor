import { expect, type Page, test } from '@playwright/test';
import { createProject, editor, open, synced, upload } from '../editing.js';
import { createAccount, signIn } from '../instance.js';

/** The PDF viewer once it shows a PDF with at least one page. */
async function pdfShown(page: Page): Promise<string> {
  const viewer = page.getByTestId('pdf-viewer');
  await expect(viewer).not.toHaveAttribute('data-url', '', { timeout: 60_000 });
  await expect(viewer).not.toHaveAttribute('data-pages', '0');
  return (await viewer.getAttribute('data-url')) ?? '';
}

async function compileStatus(page: Page, status: string, timeout = 60_000): Promise<void> {
  await expect(page.getByTestId('compile-status')).toHaveAttribute('data-status', status, {
    timeout,
  });
}

/** Chooses the main document and waits for the server to record it. */
async function setMainFile(page: Page, name: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.ok(),
  );
  await page.getByLabel('Document principal').selectOption({ label: name });
  await saved;
}

/** A document long enough to scroll through: one section per page. */
function longDocument(pages: number): string {
  const body = Array.from(
    { length: pages },
    (_, index) =>
      `\\section{Part ${String(index + 1)}}\nText of part ${String(index + 1)}.\n\\newpage`,
  );
  return `\\documentclass{article}\n\\begin{document}\n${body.join('\n')}\n\\end{document}\n`;
}

test.describe('compilation', () => {
  // A first compilation may wait for the worker to load TeX Live's formats.
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await signIn(page, createAccount('author'));
  });

  test('compiles a new project when it opens and shows the PDF', async ({ page }) => {
    await createProject(page, 'Premier PDF');
    await compileStatus(page, 'success');
    await pdfShown(page);
  });

  test('opens the source of an error from the log', async ({ page }) => {
    await createProject(page, 'Erreur cliquable');
    await upload(page, {
      'rapport.tex':
        '\\documentclass{article}\n\\begin{document}\n\\input{chapitre}\n\\end{document}\n',
      'chapitre.tex': 'Une ligne.\nUne autre.\nIci \\commandeinconnue{} pose problème.\n',
    });
    await setMainFile(page, 'rapport.tex');
    await page.keyboard.press('ControlOrMeta+Enter');
    // A PDF is still produced, so the log stays closed until asked for.
    const log = page.getByRole('button', { name: /^Journal \(1 erreur/ });
    await expect(log).toBeVisible({ timeout: 60_000 });
    await log.click();

    const diagnostics = page.getByTestId('diagnostics');
    const entry = diagnostics.getByRole('button', { name: /Undefined control sequence/ });
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('chapitre.tex:3');
    await entry.click();
    await expect(page.getByRole('tab', { name: /chapitre\.tex/, selected: true })).toBeVisible();
    await expect(page.locator('.cm-editor:visible .cm-activeLine')).toContainText(
      'commandeinconnue',
    );
    // The editor marks the line in its gutter too.
    await expect(page.locator('.cm-editor:visible .cm-lint-marker-error')).toHaveCount(1);
  });

  test('A4: keeps the reading position across recompilations', async ({ page }) => {
    await createProject(page, 'Position de lecture');
    await upload(page, { 'long.tex': longDocument(12) });
    await setMainFile(page, 'long.tex');
    await open(page, 'long.tex');
    await page.keyboard.press('ControlOrMeta+s');
    await compileStatus(page, 'success');
    const first = await pdfShown(page);
    await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-pages', '12');

    const viewer = page.getByTestId('pdf-viewer');
    await viewer.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
    });
    const before = await viewer.evaluate((element) => element.scrollTop);
    expect(before).toBeGreaterThan(500);

    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('% modifié');
    await synced(page);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(viewer).not.toHaveAttribute('data-url', first, { timeout: 60_000 });
    await expect
      .poll(() => viewer.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(before - 50);
    expect(await viewer.evaluate((element) => element.scrollTop)).toBeLessThan(before + 50);
  });

  test('cancels a running compilation', async ({ page }) => {
    await createProject(page, 'Boucle infinie');
    await compileStatus(page, 'success');
    await upload(page, {
      'boucle.tex':
        '\\documentclass{article}\n\\begin{document}\n\\def\\boucle{\\boucle}\\boucle\n\\end{document}\n',
    });
    await setMainFile(page, 'boucle.tex');
    await page.keyboard.press('ControlOrMeta+Enter');
    await compileStatus(page, 'running');
    await page.getByRole('button', { name: 'Annuler' }).click();
    await compileStatus(page, 'cancelled', 20_000);
  });
});
