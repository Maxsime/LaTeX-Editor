import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  compileStatus,
  createProject,
  editor,
  importZip,
  open,
  pdfShown,
  synced,
  upload,
} from '../editing.js';
import { createAccount, fixtureProject, signIn, storedZip } from '../instance.js';

/** Every file of a corpus project, by project-relative path, test metadata excluded. */
async function projectFiles(root: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'expected.json') continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(root, path)] = await readFile(path);
  }
  return files;
}

/**
 * Text reduced to plain ASCII, so that a phrase of the PDF matches its source:
 * ligatures (ﬁ) are split, and accents dropped, whether the source spells them
 * as letters (é) or OT1 fonts draw them as separate glyphs (´e).
 */
function plain(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[`^]/g, '')
    .trim();
}

/** Name of the active tab and line of the cursor in its editor. */
async function cursorPlace(page: Page): Promise<string> {
  const tab =
    (await page
      .getByRole('tablist', { name: 'Fichiers ouverts' })
      .getByRole('tab', { selected: true })
      .textContent()) ?? '';
  const line =
    (await page.locator('.cm-editor:visible .cm-lineNumbers .cm-activeLineGutter').textContent()) ??
    '';
  return `${tab.trim()}:${line.trim()}`;
}

/** Text of the PDF's text layer, span by span, for one page brought into view. */
async function pageSpans(page: Page, pageNumber: number) {
  const pageElement = page.locator(`.page[data-page-number="${String(pageNumber)}"]`);
  await pageElement.scrollIntoViewIfNeeded();
  const spans = pageElement.locator('.textLayer span:not(:has(span))');
  await expect(spans.first()).toBeAttached({ timeout: 10_000 });
  return spans;
}

test.describe('navigation between source and PDF', () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await signIn(page, createAccount('reader'));
  });

  test('A1: a double-click in the PDF opens the line that produced it', async ({ page }) => {
    const files = await projectFiles(fixtureProject('02-report'));
    await importZip(page, 'Navigation.zip', storedZip(files));
    await expect(page.getByRole('heading', { level: 1, name: 'Navigation' })).toBeVisible();
    await compileStatus(page, 'success', 90_000);
    await pdfShown(page);

    // Source lines by text, to find where a phrase of the PDF comes from.
    const lines: { file: string; line: number; text: string }[] = [];
    for (const [path, data] of Object.entries(files)) {
      if (!path.endsWith('.tex')) continue;
      data
        .toString('utf8')
        .split('\n')
        .forEach((text, index) => lines.push({ file: path, line: index + 1, text: plain(text) }));
    }

    const pages = Number(await page.getByTestId('pdf-viewer').getAttribute('data-pages'));
    let measured = 0;
    let correct = 0;
    const misses: string[] = [];
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const spans = await pageSpans(page, pageNumber);
      for (const span of await spans.all()) {
        const text = plain((await span.textContent()) ?? '');
        if (text.length < 15) continue;
        const sources = lines.filter((line) => line.text.includes(text));
        const [source] = sources;
        // Phrases found in several lines, or rewritten by TeX (accents, ties), prove nothing.
        if (sources.length !== 1 || source === undefined) continue;
        measured += 1;
        const name = source.file.split('/').at(-1) ?? source.file;
        const box = await span.boundingBox();
        if (box === null) continue;
        await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
        const accepted = [source.line - 1, source.line, source.line + 1].map(
          (line) => `${name}:${String(line)}`,
        );
        try {
          await expect
            .poll(() => cursorPlace(page), { timeout: 5_000 })
            .toMatch(new RegExp(`^(${accepted.join('|')})$`));
          correct += 1;
        } catch {
          misses.push(
            `"${text}" -> ${await cursorPlace(page)}, expected ${name}:${String(source.line)}`,
          );
        }
      }
    }
    expect(measured, 'phrases of the PDF traced to one source line').toBeGreaterThanOrEqual(8);
    expect(correct / measured, misses.join('\n')).toBeGreaterThanOrEqual(0.95);
  });

  test('shows the line of the cursor in the PDF', async ({ page }) => {
    const files = await projectFiles(fixtureProject('02-report'));
    await importZip(page, 'Vers le PDF.zip', storedZip(files));
    await compileStatus(page, 'success', 90_000);
    await pdfShown(page);
    await page.getByRole('treeitem', { name: /^chapters/ }).click();
    await open(page, 'figures.tex');
    await editor(page).getByText('Les trois formats sont acceptés').click();
    await page.keyboard.press('Control+Alt+KeyJ');

    const highlight = page.getByTestId('synctex-highlight').first();
    await expect(highlight).toBeVisible({ timeout: 10_000 });
    // The highlight sits on the page that shows the sentence.
    const pageWithHighlight = page.locator('.page', { has: page.getByTestId('synctex-highlight') });
    await expect(pageWithHighlight.locator('.textLayer')).toContainText('Les trois formats');
  });

  test('completes citation keys and flags unknown references as you type', async ({ page }) => {
    const refused: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
        refused.push(message.text());
      }
    });
    await createProject(page, 'Citations');
    await upload(page, {
      'refs.bib':
        '@book{knuth84,\n  author = {Knuth, Donald E.},\n  title = {The TeXbook},\n  year = {1984}\n}\n',
      'article.tex':
        '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\\label{sec:intro}\n\\end{document}\n',
    });
    // The index read at load time includes the uploaded bibliography.
    await page.reload();
    await open(page, 'article.tex');
    // CodeMirror's style sheet is allowed by the page's CSP nonce.
    await expect(page.locator('.cm-editor:visible .cm-gutters')).toHaveCSS('display', 'flex');
    await editor(page).getByText('\\section{Intro}').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Voir \\cite{kn');
    const tooltip = page.locator('.cm-tooltip-autocomplete');
    const option = tooltip.getByRole('option', { name: /knuth84/ });
    await expect(option).toContainText('Knuth (1984)');
    // CodeMirror ignores Enter for a moment after the list changes; a click is deterministic.
    await option.click();
    await expect(page.locator('.cm-editor:visible .cm-activeLine')).toContainText(
      '\\cite{knuth84}',
    );

    await page.keyboard.press('End');
    await page.keyboard.type(' et \\ref{nulle-part}');
    await synced(page);
    const warning = page.locator('.cm-editor:visible .cm-lintRange-warning');
    await expect(warning).toHaveCount(1);
    await expect(warning).toHaveText('nulle-part');
    // A known label raises nothing.
    await page.keyboard.type(' \\ref{sec:intro}');
    await page.keyboard.press('Escape');
    await expect(warning).toHaveCount(1);
    expect(refused).toEqual([]);
  });
});
