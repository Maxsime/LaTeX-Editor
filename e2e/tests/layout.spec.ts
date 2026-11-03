import { expect, test } from '@playwright/test';
import { compileStatus, editor, importZip, pdfShown } from '../editing.js';
import { createAccount, signIn, storedZip } from '../instance.js';

const document = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Page un.',
  '\\newpage',
  'Page deux.',
  '\\newpage',
  'Page trois.',
  '\\end{document}',
  '',
].join('\n');

test.describe('workspace layout', () => {
  test('opens on the main file beside its PDF, with a floating PDF toolbar', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await signIn(page, createAccount('layout'));
    await importZip(page, 'Disposition.zip', storedZip({ 'main.tex': Buffer.from(document) }));
    await expect(page.getByRole('heading', { level: 1, name: 'Disposition' })).toBeVisible();

    // The main file opens by itself, as in Prism.
    await expect(page.getByRole('tab', { name: /main\.tex/, selected: true })).toBeVisible();
    await expect(editor(page)).toContainText('Page un.');

    await compileStatus(page, 'success', 90_000);
    await pdfShown(page);
    const toolbar = page.getByRole('toolbar', { name: "Barre d'outils du PDF" });
    const current = toolbar.getByLabel('Page affichée');
    await expect(current).toHaveValue('1');
    await expect(toolbar).toContainText('/ 3');
    await toolbar.getByRole('button', { name: 'Page suivante' }).click();
    await expect(current).toHaveValue('2');
    await current.fill('3');
    await expect(current).toHaveValue('3');
    await expect(toolbar.getByRole('button', { name: 'Page suivante' })).toBeDisabled();

    const zoom = toolbar.getByLabel('Zoom', { exact: true });
    await expect(zoom).toHaveValue('page-width');
    await toolbar.getByRole('button', { name: 'Zoom avant' }).click();
    await expect(zoom).not.toHaveValue('page-width');

    // The workspace fills the window: the panes scroll, never the page itself.
    const overflow = await page.evaluate(
      () => window.document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const pane = await page.getByRole('region', { name: 'Compilation et aperçu' }).boundingBox();
    expect(pane?.width ?? 0).toBeGreaterThan(500);
  });

  test('folds errors and warnings under the PDF, and remembers the choice', async ({ page }) => {
    await signIn(page, createAccount('folding'));
    await importZip(page, 'Repli.zip', storedZip({ 'main.tex': Buffer.from(document) }));
    await compileStatus(page, 'success', 90_000);
    await pdfShown(page);

    // Folded by default: a single line sums them up, the PDF keeps the room.
    const strip = page.getByRole('button', { name: /^Journal \(0 erreur, 0 avertissement\)/ });
    await expect(strip).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('tab', { name: 'Journal brut' })).toHaveCount(0);

    await strip.click();
    await expect(strip).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('tab', { name: 'Journal brut' })).toBeVisible();

    await page.reload();
    await compileStatus(page, 'success', 90_000);
    await expect(strip).toHaveAttribute('aria-expanded', 'true');
    await strip.click();
    await expect(page.getByRole('tab', { name: 'Journal brut' })).toHaveCount(0);
  });

  test('keeps dialogs above the PDF and its toolbar', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await signIn(page, createAccount('stacking'));
    await importZip(page, 'Empilement.zip', storedZip({ 'main.tex': Buffer.from(document) }));
    await compileStatus(page, 'success', 90_000);
    await pdfShown(page);
    const toolbar = page.getByRole('toolbar', { name: "Barre d'outils du PDF" });
    const box = await toolbar.boundingBox();
    if (box === null) throw new Error('PDF toolbar not laid out');

    await page.getByRole('button', { name: 'Historique', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Historique du projet' });
    await expect(dialog).toBeVisible();
    // Whatever sits under the PDF toolbar now belongs to the dialog or to its backdrop.
    const onTop = await page.evaluate(
      ({ x, y }) => {
        const hit = window.document.elementFromPoint(x, y);
        return hit !== null && hit.closest('[role="toolbar"], [data-testid="pdf-viewer"]') === null;
      },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(onTop).toBe(true);
    const pane = await page.getByRole('region', { name: 'Compilation et aperçu' }).boundingBox();
    if (pane === null) throw new Error('PDF pane not laid out');
    const inDialog = await page.evaluate(
      ({ x, y }) => window.document.elementFromPoint(x, y)?.closest('[role="dialog"]') !== null,
      { x: pane.x + 40, y: pane.y + 160 },
    );
    expect(inDialog).toBe(true);
  });
});
