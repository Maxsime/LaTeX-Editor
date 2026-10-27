import { expect, type Page, test } from '@playwright/test';
import * as Y from 'yjs';
import { editor, open, sendRawUpdate, synced } from '../editing.js';
import {
  editorText,
  joinThroughLink,
  participant,
  serverText,
  shareLink,
  sharedProject,
  SOURCE,
} from '../people.js';

async function openPanel(page: Page, name: 'Revue' | 'Discussion'): Promise<void> {
  await page.getByRole('tablist', { name: 'Panneaux' }).getByRole('tab', { name }).click();
}

async function pressTimes(page: Page, key: string, times: number): Promise<void> {
  let remaining = times;
  while (remaining > 0) {
    await page.keyboard.press(key);
    remaining -= 1;
  }
}

test.describe('review', () => {
  test('J7 A1, A2: a reviewer suggests, an editor accepts one suggestion and rejects another', async ({
    browser,
  }) => {
    const owner = await participant(browser, 'owner');
    const reviewer = await participant(browser, 'reviewer');
    const { projectId, fileId } = await sharedProject(owner.page, 'Relecture');
    await joinThroughLink(reviewer.page, await shareLink(owner.page, 'Relecteur'), 'Relecture');

    // Reviewers write, but only in suggestion mode.
    await open(reviewer.page, 'collab.tex');
    const mode = reviewer.page.getByRole('checkbox', { name: 'Suggérer' });
    await expect(mode).toBeChecked();
    await expect(mode).toBeDisabled();
    await expect(editor(reviewer.page)).toHaveAttribute('contenteditable', 'true');

    await editor(reviewer.page).getByText('Le paragraphe commun.').click();
    await reviewer.page.keyboard.press('End');
    await reviewer.page.keyboard.type(' Ajout.');
    // Select "commun", after "Le paragraphe ", and delete it.
    await reviewer.page.keyboard.press('Home');
    await pressTimes(reviewer.page, 'ArrowRight', 'Le paragraphe '.length);
    await pressTimes(reviewer.page, 'Shift+ArrowRight', 'commun'.length);
    await reviewer.page.keyboard.press('Backspace');
    await synced(reviewer.page);
    await expect(editor(reviewer.page).locator('.cm-suggest-insert')).toHaveText(' Ajout.');
    await expect(editor(reviewer.page).locator('.cm-suggest-delete')).toHaveText('commun');
    // The stored text is the proposal: compilation shows what the reviewer suggests.
    await expect
      .poll(() => serverText(owner.page, projectId, fileId))
      .toContain('Le paragraphe . Ajout.');

    // A direct edit forged on the reviewer's own session is refused by the server.
    const forged = new Y.Doc();
    forged.getText('content').insert(0, 'FORGED ');
    const replies = await sendRawUpdate(
      reviewer.page,
      `file:${fileId}`,
      Array.from(Y.encodeStateAsUpdate(forged)),
    );
    expect(replies).toBeGreaterThan(0);
    await expect.poll(() => serverText(owner.page, projectId, fileId)).not.toContain('FORGED');

    // The owner decides, from the review panel.
    await open(owner.page, 'collab.tex');
    await openPanel(owner.page, 'Revue');
    const suggestions = owner.page.getByTestId('suggestion');
    await expect(suggestions).toHaveCount(2);
    await owner.page
      .locator('[data-testid="suggestion"][data-kind="insert"]')
      .getByRole('button', { name: 'Accepter' })
      .click();
    await owner.page
      .locator('[data-testid="suggestion"][data-kind="delete"]')
      .getByRole('button', { name: 'Rejeter' })
      .click();
    await expect(suggestions).toHaveCount(0);
    await synced(owner.page);
    await expect
      .poll(() => serverText(owner.page, projectId, fileId))
      .toBe(SOURCE.replace('Le paragraphe commun.', 'Le paragraphe commun. Ajout.'));
    await expect.poll(() => editorText(reviewer.page)).toContain('Le paragraphe commun. Ajout.');
    await expect(editor(reviewer.page).locator('.cm-suggest-insert')).toHaveCount(0);
  });

  test('a comment that mentions someone reaches their dashboard, and the chat is live', async ({
    browser,
  }) => {
    const owner = await participant(browser, 'owner');
    const reviewer = await participant(browser, 'reviewer');
    await sharedProject(owner.page, 'Commentaires');
    await joinThroughLink(reviewer.page, await shareLink(owner.page, 'Relecteur'), 'Commentaires');

    await open(reviewer.page, 'collab.tex');
    await editor(reviewer.page).getByText('Le paragraphe commun.').dblclick();
    await reviewer.page.keyboard.press('Control+Alt+m');
    const body = reviewer.page.getByRole('textbox', { name: 'Commentaire' });
    await expect(body).toBeFocused();
    await body.fill(`À reformuler, @${owner.account.login} ?`);
    await reviewer.page.getByRole('button', { name: 'Commenter' }).click();
    const thread = reviewer.page.getByTestId('thread');
    await expect(thread).toContainText('À reformuler');
    await expect(editor(reviewer.page).locator('.cm-comment-anchor')).toBeVisible();

    // The mention waits on the owner's dashboard, and leads to the review panel.
    await owner.page.goto('/projects');
    const mentions = owner.page.getByRole('region', { name: 'On vous mentionne' });
    await expect(mentions).toContainText('À reformuler');
    await mentions.getByRole('button', { name: 'Ouvrir' }).click();
    await expect(owner.page.getByRole('heading', { level: 1, name: 'Commentaires' })).toBeVisible();
    await expect(owner.page.getByTestId('thread')).toContainText('À reformuler');
    await owner.page.goto('/projects');
    await expect(owner.page.getByRole('region', { name: 'On vous mentionne' })).toHaveCount(0);

    // Chat messages arrive without reloading.
    await owner.page.goBack();
    await openPanel(owner.page, 'Discussion');
    await openPanel(reviewer.page, 'Discussion');
    await reviewer.page.getByRole('textbox', { name: 'Message' }).fill('Je relis la suite demain.');
    await reviewer.page.getByRole('button', { name: 'Envoyer' }).click();
    await expect(owner.page.getByTestId('chat-message')).toContainText('Je relis la suite demain.');
  });
});
