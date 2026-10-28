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

async function setMainFile(page: Page, name: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.ok(),
  );
  await page.getByLabel('Document principal').selectOption({ label: name });
  await saved;
}

async function compile(page: Page): Promise<void> {
  const done = page.waitForResponse(
    (response) => response.url().endsWith('/compile') && response.status() === 202,
  );
  await page.getByRole('button', { name: 'Compiler', exact: true }).click();
  await done;
  await compileStatus(page, 'success');
}

const MAIN = String.raw`\documentclass{article}
\usepackage{amsmath}
\usepackage{tikz}
\newcommand{\carre}[1]{#1^{2}}
\begin{document}
Texte premier.
\begin{equation}
  E = \carre{m}
\end{equation}
\end{document}
`;

test.describe('compilation extras', () => {
  test.setTimeout(150_000);

  test.beforeEach(async ({ page }) => {
    await signIn(page, createAccount('compilextras'));
  });

  test('compiles with a precompiled preamble', async ({ page }) => {
    await createProject(page, 'Préambule');
    await upload(page, { 'rapport.tex': MAIN });
    await setMainFile(page, 'rapport.tex');
    await page.getByRole('button', { name: 'Options' }).click();
    const saved = page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.ok(),
    );
    const option = page.getByRole('checkbox', { name: /Précompiler le préambule/ });
    await option.click();
    await saved;
    await expect(option).toBeChecked();
    await page.keyboard.press('Escape');
    await compile(page);
    await compile(page);
    await page.getByRole('button', { name: /^Journal/ }).click();
    await page.getByRole('tab', { name: 'Journal brut' }).click();
    await expect(page.getByText(/preloaded format=galley-preamble/)).toBeVisible();
  });

  test('compiles the version under review, without the suggestions', async ({ page }) => {
    await createProject(page, 'Version d’origine');
    await upload(page, { 'rapport.tex': MAIN });
    await setMainFile(page, 'rapport.tex');
    await open(page, 'rapport.tex');
    await page.getByRole('checkbox', { name: 'Suggérer' }).check();
    await editor(page).getByText('Texte premier.').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Ajout propose.');
    await synced(page);

    await compile(page);
    await pdfShown(page);
    const pdf = page.getByTestId('pdf-viewer');
    await expect(pdf).toContainText('Ajout propose.');
    await expect(page.getByTestId('original-badge')).toHaveCount(0);

    await page.getByRole('button', { name: 'Options' }).click();
    await page.getByRole('checkbox', { name: /Compiler sans les suggestions/ }).check();
    await page.keyboard.press('Escape');
    await compile(page);
    await expect(page.getByTestId('original-badge')).toHaveText("Version d'origine");
    await expect(pdf).toContainText('Texte premier.');
    await expect(pdf).not.toContainText('Ajout propose.');
  });

  test('previews the formula under the cursor alone, with the preamble', async ({ page }) => {
    await createProject(page, 'Aperçu isolé');
    await upload(page, { 'rapport.tex': MAIN });
    await setMainFile(page, 'rapport.tex');
    await open(page, 'rapport.tex');
    await editor(page).getByText('\\carre{m}').click();
    await page.getByRole('button', { name: 'Aperçu isolé' }).click();
    const bubble = page.getByTestId('fragment-preview');
    await expect(bubble.getByTestId('pdf-viewer')).not.toHaveAttribute('data-pages', '0', {
      timeout: 60_000,
    });
    await expect(bubble.getByTestId('pdf-viewer')).toContainText('m');

    // In plain text, there is nothing to preview.
    await page.keyboard.press('Escape');
    await editor(page).getByText('Texte premier.').click();
    await page.getByRole('button', { name: 'Aperçu isolé' }).click();
    await expect(bubble).toContainText('Sélectionnez du code');
  });
});
