import { expect, type Page, test } from '@playwright/test';
import { compileStatus, createProject, editor, open, synced, upload } from '../editing.js';
import { createAccount, signIn } from '../instance.js';

async function setMainFile(page: Page, name: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.ok(),
  );
  await page.getByLabel('Document principal').selectOption({ label: name });
  await saved;
}

/** Puts the cursor at the end of the line holding `text`. */
async function cursorAfter(page: Page, text: string): Promise<void> {
  await editor(page).getByText(text).click();
  await page.keyboard.press('End');
}

test.describe('writing tools', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await signIn(page, createAccount('writer'));
  });

  test('imports pasted BibTeX, cites it from the panel and compiles with Biber', async ({
    page,
  }) => {
    await createProject(page, 'Bibliographie');
    await upload(page, {
      'memoire.tex': [
        '\\documentclass{article}',
        '\\usepackage[backend=biber]{biblatex}',
        '\\addbibresource{references.bib}',
        '\\begin{document}',
        'Voir la référence',
        '\\printbibliography',
        '\\end{document}',
        '',
      ].join('\n'),
    });
    await setMainFile(page, 'memoire.tex');

    await page.getByRole('tab', { name: 'Références' }).click();
    await page.getByRole('button', { name: 'Importer' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'BibTeX collé' }).click();
    await dialog
      .getByLabel('BibTeX collé')
      .fill(
        '@book{knuth1984,\n  author = {Knuth, Donald E.},\n  title = {The {\\TeX}book},\n  publisher = {Addison-Wesley},\n  year = {1984}\n}',
      );
    await dialog.getByLabel('Garder les clés telles quelles').check();
    await dialog.getByRole('button', { name: 'Rechercher' }).click();
    await expect(dialog.getByTestId('import-preview')).toContainText('@book{knuth1984,');
    await dialog.getByLabel('Ajouter à').selectOption({ label: 'Nouveau fichier references.bib' });
    await dialog.getByRole('button', { name: "Ajouter l'entrée" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('tab', { name: 'Fichiers' }).click();
    await expect(page.getByRole('treeitem', { name: /references\.bib/ })).toBeVisible();
    await open(page, 'memoire.tex');
    await cursorAfter(page, 'Voir la référence');
    await page.getByRole('tab', { name: 'Références' }).click();
    const entry = page.getByTestId('reference-knuth1984');
    await expect(entry).toContainText('non citée');
    await entry.getByRole('button', { name: 'Citer' }).click();
    await expect(editor(page)).toContainText('Voir la référence\\cite{knuth1984}');
    await synced(page);

    await page.keyboard.press('ControlOrMeta+Enter');
    await compileStatus(page, 'success');
    // Biber resolved the key: no warning about an undefined citation.
    await expect(page.getByRole('button', { name: /^Journal/ })).toHaveText(
      'Journal (0 erreur, 0 avertissement)',
    );
    await expect(entry).not.toContainText('non citée', { timeout: 15_000 });
  });

  test('A3: underlines a French spelling mistake and corrects it', async ({ page }) => {
    await createProject(page, 'Orthographe');
    await upload(page, {
      'texte.tex':
        '\\documentclass{article}\n\\usepackage[french]{babel}\n\\begin{document}\nIl fesait beau ce matin-là.\n\\end{document}\n',
    });
    await setMainFile(page, 'texte.tex');
    await open(page, 'texte.tex');
    // LanguageTool may still be starting: its first answer can take a while.
    const mistake = page.locator('.cm-editor:visible .cm-spell-spelling', { hasText: 'fesait' });
    await expect(mistake).toBeVisible({ timeout: 90_000 });
    // The LaTeX markup itself is never underlined.
    await expect(page.locator('.cm-editor:visible [class*="cm-spell-"]')).toHaveCount(1);
    await mistake.hover();
    // LanguageTool's first proposal; its list depends on its dictionary version.
    const replacement = page.getByRole('button', { name: /^Action: / }).first();
    const word = (await replacement.textContent()) ?? '';
    expect(word).not.toBe('');
    await replacement.click();
    await expect(editor(page)).toContainText(`Il ${word} beau`);
    await expect(mistake).toHaveCount(0);
  });

  test('marks chktex warnings and turns a rule off from the marker', async ({ page }) => {
    await createProject(page, 'Lint');
    await upload(page, {
      'lint.tex':
        '\\documentclass{article}\n\\begin{document}\n\\section{Un}\\label{s}\nVoir la section \\ref{s}.\n\\end{document}\n',
    });
    await setMainFile(page, 'lint.tex');
    await open(page, 'lint.tex');
    await page.keyboard.press('ControlOrMeta+Enter');
    await compileStatus(page, 'success');
    const marker = page.locator('.cm-editor:visible .cm-lint-marker-info');
    await expect(marker).toHaveCount(1);
    // Hovers the underlined range itself, and again if the tooltip missed the
    // first pass: on a loaded machine the editor can still be laying out the
    // line when the pointer arrives.
    const range = page.locator('.cm-editor:visible .cm-lintRange-info');
    await expect(async () => {
      await page.mouse.move(0, 0);
      await range.hover();
      await expect(page.getByText('chktex 2')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const saved = page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.ok(),
    );
    await page.getByRole('button', { name: 'Désactiver cette règle' }).click();
    await saved;
    await expect(marker).toHaveCount(0);
  });

  test('inserts symbols and tables, and previews formulas', async ({ page }) => {
    await createProject(page, 'Insertion');
    await open(page, 'main.tex');
    await cursorAfter(page, 'Hello');

    await page.getByRole('button', { name: 'Symboles' }).click();
    await page.getByLabel('Nom ou commande').fill('alpha');
    await page.getByRole('button', { name: '\\alpha' }).click();
    await expect(editor(page)).toContainText('Hello, \\LaTeX!\\alpha');

    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Tableau', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Cellule ligne 1, colonne 1').fill('Grandeur');
    await dialog.getByLabel('Cellule ligne 2, colonne 1').fill('$R$');
    await expect(dialog.getByRole('note')).toContainText('\\usepackage{booktabs}');
    await dialog.getByRole('button', { name: 'Insérer' }).click();
    await expect(editor(page)).toContainText('\\toprule');
    await expect(editor(page)).toContainText('Grandeur &  &  \\\\');

    await page.keyboard.type('\nOn pose $\\frac{a}{b}$ ici.');
    await editor(page).getByText('frac').hover();
    await expect(page.getByTestId('math-preview').locator('.katex')).toBeVisible();
    await synced(page);
  });
});
