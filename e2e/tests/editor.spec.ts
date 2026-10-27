import { expect, test } from '@playwright/test';
import { createProject, editor, open, synced, upload } from '../editing.js';
import { createAccount, signIn } from '../instance.js';

test.describe('editor', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, createAccount('writer'));
  });

  test('A1: edits a 5 000-line file smoothly', async ({ page }) => {
    await createProject(page, 'Long document');
    const lines = Array.from({ length: 5000 }, (_, index) =>
      index % 50 === 0
        ? `\\section{Part ${String(index / 50)}}`
        : `Line ${String(index)} with $x^2$ and text.`,
    );
    await upload(page, { 'long.tex': `${lines.join('\n')}\n` });
    await open(page, 'long.tex');
    await expect(editor(page)).toContainText('\\section{Part 0}');

    await editor(page).click();
    await page.keyboard.press('Control+End');
    const typed = 'Appended at the end of a long document';
    const started = Date.now();
    await page.keyboard.type(typed, { delay: 0 });
    await expect(editor(page)).toContainText(typed);
    // Typing must not lag: each keystroke is applied in well under the 50 ms budget.
    expect(Date.now() - started).toBeLessThan(typed.length * 50);

    await page.keyboard.press('Control+Home');
    await expect(editor(page)).toContainText('\\section{Part 0}');
    await synced(page);
  });

  test('A2: keeps every edit across a reload', async ({ page }) => {
    await createProject(page, 'Rechargement');
    await open(page, 'main.tex');
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Texte saisi juste avant le rechargement.');
    await synced(page);
    await page.reload();

    await open(page, 'main.tex');
    await expect(editor(page)).toContainText('Texte saisi juste avant le rechargement.');

    // The API reads the same text: collab writes it before any read.
    const fileId = (
      await page.locator('[data-testid^="editor-"]:visible').getAttribute('data-testid')
    )?.replace('editor-', '');
    const projectId = /\/projects\/([^/]+)$/.exec(page.url())?.[1];
    const content = await page.request.get(
      `/api/projects/${projectId ?? ''}/files/${fileId ?? ''}/content`,
    );
    expect(await content.text()).toContain('Texte saisi juste avant le rechargement.');
  });

  test('A3: navigates with the outline and searches the project', async ({ page }) => {
    await createProject(page, 'Thèse');
    await upload(page, {
      'main.tex': [
        '\\documentclass{report}',
        '\\begin{document}',
        '\\chapter{Introduction}',
        'Le contexte.',
        '\\input{methodes}',
        '\\chapter{Conclusion}',
        'Fin du document.',
        '\\end{document}',
        '',
      ].join('\n'),
      'methodes.tex': [
        '\\section{Méthodes}',
        'Une mesure précise.',
        '\\section{Résultats}',
        'Mesure finale.',
        '',
      ].join('\n'),
    });

    await page.getByRole('tab', { name: 'Plan' }).click();
    const outline = page.getByTestId('outline');
    await expect(outline.getByRole('button')).toHaveText([
      'Introduction',
      'Méthodes',
      'Résultats',
      'Conclusion',
    ]);
    await outline.getByRole('button', { name: 'Résultats' }).click();
    await expect(page.getByRole('tab', { name: /methodes\.tex/, selected: true })).toBeVisible();
    await expect(page.locator('.cm-editor:visible .cm-activeLine')).toHaveText(
      '\\section{Résultats}',
    );
    await expect(outline.getByRole('button', { name: 'Résultats' })).toHaveAttribute(
      'aria-current',
      'location',
    );

    // Editing a heading refreshes the outline after a pause.
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type(' et discussion');
    await expect(outline.getByRole('button', { name: 'Résultats et discussion' })).toBeVisible();

    await page.getByRole('tab', { name: 'Recherche' }).click();
    const panel = page.getByTestId('search-panel');
    await panel.getByLabel('Rechercher dans le projet').fill('mesure');
    await panel.getByRole('button', { name: 'Rechercher' }).click();
    await expect(panel.getByRole('status').first()).toHaveText('2 résultats dans 1 fichier(s).');
    await panel.getByLabel('Respecter la casse').check();
    await panel.getByRole('button', { name: 'Rechercher' }).click();
    await expect(page.getByTestId('search-results').getByRole('button')).toHaveCount(1);
    await page.getByTestId('search-results').getByRole('button').first().click();
    await expect(page.locator('.cm-editor:visible .cm-activeLine')).toHaveText(
      'Une mesure précise.',
    );

    await panel.getByLabel('Respecter la casse').uncheck();
    await panel.getByRole('button', { name: 'Rechercher' }).click();
    await panel.getByLabel('Remplacer par').fill('observation');
    await panel.getByRole('button', { name: 'Tout remplacer' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Tout remplacer' }).click();
    await expect(panel.getByText('2 remplacements dans 1 fichier(s).')).toBeVisible();
    await expect(editor(page)).toContainText('Une observation précise.');
    await expect(editor(page)).toContainText('observation finale.');
  });
});
