import { expect, type Page, test } from '@playwright/test';
import { compileStatus, editor, importZip, pdfShown, synced } from '../editing.js';
import { createAccount, signIn, storedZip } from '../instance.js';

const source = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Page un.',
  '\\newpage',
  'Page deux.',
  '\\end{document}',
  '',
].join('\n');

declare global {
  interface Window {
    seenClass?: boolean;
    blankFrames?: number;
    watching?: boolean;
  }
}

/** Records, from now on, whether the root element ever carries a class. */
async function watchRootClass(page: Page, name: string): Promise<() => Promise<boolean>> {
  await page.evaluate((watched) => {
    const root = window.document.documentElement;
    window.seenClass = false;
    new MutationObserver(() => {
      if (root.classList.contains(watched)) window.seenClass = true;
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
  }, name);
  return () => page.evaluate(() => window.seenClass === true);
}

/** Widths of the editor and of the PDF pane. */
async function paneWidths(page: Page): Promise<{ editor: number; pdf: number }> {
  const editorBox = await page.locator('section:has(.cm-editor)').boundingBox();
  const pdfBox = await page.getByRole('region', { name: 'Compilation et aperçu' }).boundingBox();
  return { editor: editorBox?.width ?? 0, pdf: pdfBox?.width ?? 0 };
}

test.describe('motion', () => {
  test('cross-fades between day and night, unless the system asks for less motion', async ({
    page,
  }) => {
    await page.goto('/status');
    const toggle = page.getByRole('button', { name: 'Mode nuit' });
    let faded = await watchRootClass(page, 'theme-transition');
    await toggle.click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    expect(await faded()).toBe(true);
    // The fade is over quickly and leaves nothing behind.
    await expect(page.locator('html')).not.toHaveClass(/theme-transition/);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    faded = await watchRootClass(page, 'theme-transition');
    await page.getByRole('button', { name: 'Mode nuit' }).click();
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    expect(await faded()).toBe(false);
  });
});

test.describe('workspace motion', () => {
  test.setTimeout(150_000);

  test('resizes the editor and the PDF with the separator, and remembers it', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await signIn(page, createAccount('splitter'));
    await importZip(page, 'Séparateur.zip', storedZip({ 'main.tex': Buffer.from(source) }));
    await expect(page.getByRole('heading', { level: 1, name: 'Séparateur' })).toBeVisible();
    await expect(editor(page)).toContainText('Page un.');

    const separator = page.getByRole('separator', { name: "Séparateur entre l'éditeur et le PDF" });
    await expect(separator).toHaveAttribute('aria-valuenow', '50');
    const even = await paneWidths(page);
    expect(Math.abs(even.editor - even.pdf)).toBeLessThan(4);

    // Dragging to the right widens the editor.
    const box = await separator.boundingBox();
    if (box === null) throw new Error('separator not laid out');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, y, { steps: 8 });
    await page.mouse.up();
    const dragged = await paneWidths(page);
    expect(dragged.editor - dragged.pdf).toBeGreaterThan(300);
    const share = Number(await separator.getAttribute('aria-valuenow'));
    expect(share).toBeGreaterThan(60);

    // Kept across a reload.
    await page.reload();
    await expect(separator).toHaveAttribute('aria-valuenow', String(share));

    // The keyboard moves it too, and Enter puts it back in the middle.
    await separator.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(separator).toHaveAttribute('aria-valuenow', String(share - 2));
    await page.keyboard.press('End');
    await expect(separator).toHaveAttribute('aria-valuenow', '80');
    await page.keyboard.press('Enter');
    await expect(separator).toHaveAttribute('aria-valuenow', '50');

    // It only exists while both panes are shown.
    await page.getByRole('radio', { name: 'Éditeur' }).click();
    await expect(separator).toHaveCount(0);
    await page.getByRole('radio', { name: 'Côte à côte' }).click();
    await expect(separator).toBeVisible();
  });

  test('replaces the PDF after a recompilation without a blank frame', async ({ page }) => {
    await signIn(page, createAccount('swap'));
    await importZip(page, 'Sans clignoter.zip', storedZip({ 'main.tex': Buffer.from(source) }));
    await compileStatus(page, 'success', 90_000);
    const first = await pdfShown(page);
    await expect(page.locator('[data-testid="pdf-viewer"] .page canvas').first()).toBeVisible();

    // Every frame from now on, note whether the viewer on screen shows no painted page.
    await page.evaluate(() => {
      window.blankFrames = 0;
      window.watching = true;
      const check = () => {
        if (window.watching !== true) return;
        const viewer = window.document.querySelector('[data-testid="pdf-viewer"]');
        if (viewer?.querySelector('.page canvas') == null)
          window.blankFrames = (window.blankFrames ?? 0) + 1;
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });

    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('% modifié');
    await synced(page);
    await page.keyboard.press('ControlOrMeta+s');
    // A thin bar shows the compilation is under way.
    await expect(page.getByTestId('compile-progress')).toBeAttached();
    await expect(page.getByTestId('pdf-viewer')).not.toHaveAttribute('data-url', first, {
      timeout: 60_000,
    });
    await compileStatus(page, 'success');
    await expect(page.getByTestId('compile-progress')).toHaveCount(0);
    // Let the old PDF leave the page, then stop watching.
    await expect(page.locator('.pdfViewer .page[data-page-number="1"]')).toHaveCount(1);
    const blankFrames = await page.evaluate(() => {
      window.watching = false;
      return window.blankFrames ?? 0;
    });
    expect(blankFrames).toBe(0);
  });
});
