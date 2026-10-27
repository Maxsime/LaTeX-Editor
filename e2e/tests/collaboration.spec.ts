import { expect, type Page, test, type WebSocketRoute } from '@playwright/test';
import * as Y from 'yjs';
import { editor, open, sendRawUpdate, synced } from '../editing.js';
import { createAccount } from '../instance.js';
import {
  editorText,
  joinThroughLink,
  openShare,
  participant,
  serverText,
  shareLink,
  sharedProject,
  SOURCE,
} from '../people.js';

/** Puts the cursor at the end of the shared paragraph. */
async function toParagraphEnd(page: Page): Promise<void> {
  await editor(page).getByText('Le paragraphe commun.').click();
  await page.keyboard.press('End');
}

test.describe('collaboration', () => {
  test.setTimeout(180_000);

  test('A1: three browsers editing the same paragraph converge', async ({ browser }) => {
    const [owner, second, third] = await Promise.all(
      ['alice', 'bruno', 'chloe'].map((name) => participant(browser, name)),
    );
    if (!owner || !second || !third) throw new Error('missing participant');
    const { projectId, fileId } = await sharedProject(owner.page, 'Convergence');
    const url = await shareLink(owner.page, 'Éditeur');
    await joinThroughLink(second.page, url, 'Convergence');
    await joinThroughLink(third.page, url, 'Convergence');
    const all = [owner, second, third];
    for (const { page } of all) await open(page, 'collab.tex');

    // Everyone sees the two others and the file they are in.
    await expect(owner.page.getByRole('button', { name: 'bruno : collab.tex' })).toBeVisible();
    await expect(owner.page.getByRole('button', { name: 'chloe : collab.tex' })).toBeVisible();

    for (const { page } of all) await toParagraphEnd(page);
    const typed = all.map((_, index) => ` [${String(index)}] ajout concurrent ${'x'.repeat(20)}`);
    await Promise.all(
      all.map(({ page }, index) => page.keyboard.type(typed[index] ?? '', { delay: 15 })),
    );
    for (const { page } of all) await synced(page);

    const expectedLength = SOURCE.length + typed.reduce((sum, text) => sum + text.length, 0);
    await expect.poll(() => serverText(owner.page, projectId, fileId)).toHaveLength(expectedLength);
    const stored = await serverText(owner.page, projectId, fileId);
    for (const text of ['[0]', '[1]', '[2]']) expect(stored).toContain(text);
    for (const { page } of all) await expect.poll(() => editorText(page)).toBe(stored);
  });

  test('A2: a reader cannot change the document, even with a forged message', async ({
    browser,
  }) => {
    const owner = await participant(browser, 'owner');
    const reader = await participant(browser, 'reader');
    const { projectId, fileId } = await sharedProject(owner.page, 'Lecture seule');

    // Invitation by username, accepted from the reader's dashboard.
    const dialog = await openShare(owner.page);
    await dialog.getByLabel("Adresse e-mail ou nom d'utilisateur").fill(reader.account.login);
    await dialog.getByLabel('Rôle proposé').selectOption({ label: 'Lecteur' });
    await dialog.getByRole('button', { name: 'Inviter' }).click();
    await expect(dialog.getByRole('list', { name: 'Invitations en attente' })).toContainText(
      'reader',
    );
    await dialog.getByRole('button', { name: 'Fermer' }).click();
    await reader.page.reload();
    const invitations = reader.page.getByRole('region', { name: 'Invitations' });
    await expect(invitations).toContainText('Lecture seule');
    await invitations.getByRole('button', { name: 'Accepter' }).click();
    await expect(
      reader.page.getByRole('heading', { level: 1, name: 'Lecture seule' }),
    ).toBeVisible();

    // The interface offers no way to edit.
    await expect(reader.page.getByText('Lecteur', { exact: true })).toBeVisible();
    await expect(reader.page.getByRole('button', { name: 'Nouveau fichier' })).toHaveCount(0);
    await open(reader.page, 'collab.tex');
    await expect(editor(reader.page)).toHaveAttribute('contenteditable', 'false');

    // A Yjs update sent by hand on the reader's own session is dropped by the server.
    const forged = new Y.Doc();
    forged.getText('content').insert(0, 'FORGED ');
    const update = Array.from(Y.encodeStateAsUpdate(forged));
    const replies = await sendRawUpdate(reader.page, `file:${fileId}`, update);
    expect(replies).toBeGreaterThan(0);

    await open(owner.page, 'collab.tex');
    await expect.poll(() => serverText(owner.page, projectId, fileId)).toBe(SOURCE);
    await expect(editor(owner.page)).not.toContainText('FORGED');
    await expect(editor(reader.page)).not.toContainText('FORGED');
  });

  test('A3: a 30-second network outage loses no edit', async ({ browser }) => {
    const owner = await participant(browser, 'owner');
    const writer = await participant(browser, 'writer');
    const { projectId, fileId } = await sharedProject(owner.page, 'Coupure');
    const url = await shareLink(owner.page, 'Éditeur');

    // The writer's collab traffic goes through a relay the test can cut, like a network outage.
    let down = false;
    const relayed: WebSocketRoute[] = [];
    await writer.page.routeWebSocket(/\/collab$/, (socket) => {
      if (down) {
        void socket.close();
        return;
      }
      socket.connectToServer();
      relayed.push(socket);
    });
    await joinThroughLink(writer.page, url, 'Coupure');
    await open(writer.page, 'collab.tex');
    await open(owner.page, 'collab.tex');

    down = true;
    for (const socket of relayed.splice(0)) await socket.close();
    const status = writer.page.locator('[role="tab"][aria-selected="true"] [data-status]');
    await expect(status).toHaveAttribute('data-status', 'offline');

    await toParagraphEnd(writer.page);
    await writer.page.keyboard.type(' Écrit hors ligne.');
    await toParagraphEnd(owner.page);
    await owner.page.keyboard.type(' Écrit pendant la coupure.');
    await synced(owner.page);
    await writer.page.waitForTimeout(30_000);
    await expect(status).toHaveAttribute('data-status', 'offline');

    down = false;
    await expect(status).toHaveAttribute('data-status', 'saved', { timeout: 60_000 });
    for (const { page } of [owner, writer]) {
      await expect(editor(page)).toContainText('Écrit hors ligne.');
      await expect(editor(page)).toContainText('Écrit pendant la coupure.');
    }
    await expect
      .poll(() => serverText(owner.page, projectId, fileId))
      .toContain('Écrit hors ligne.');
  });

  test('a share link opened while signed out leads back to it after signing in', async ({
    browser,
  }) => {
    const owner = await participant(browser, 'owner');
    await sharedProject(owner.page, 'Par lien');
    const url = await shareLink(owner.page, 'Lecteur');
    const visitor = await (await browser.newContext()).newPage();
    const account = createAccount('visitor');
    await visitor.goto(url);
    await expect(visitor).toHaveURL(/\/login\?redirect=/);
    await visitor.getByLabel("Adresse e-mail ou nom d'utilisateur").fill(account.login);
    await visitor.getByLabel('Mot de passe').fill(account.password);
    await visitor.getByRole('button', { name: 'Se connecter' }).click();
    await expect(
      visitor.getByText('Vous êtes invité à rejoindre « Par lien » comme lecteur.'),
    ).toBeVisible();
    await visitor.getByRole('button', { name: 'Rejoindre le projet' }).click();
    await expect(visitor.getByRole('heading', { level: 1, name: 'Par lien' })).toBeVisible();

    // Revoked, the link lets nobody else in.
    const dialog = await openShare(owner.page);
    await dialog
      .getByRole('list', { name: 'Liens actifs' })
      .getByRole('button', { name: 'Révoquer' })
      .click();
    await expect(dialog.getByRole('list', { name: 'Liens actifs' })).toHaveCount(0);
    const late = await participant(browser, 'late');
    await late.page.goto(url);
    await expect(late.page.getByRole('alert')).toHaveText(
      "Ce lien de partage n'est pas valide : il a expiré ou a été révoqué.",
    );
  });

  test('removing a member closes the project in their browser', async ({ browser }) => {
    const owner = await participant(browser, 'owner');
    const member = await participant(browser, 'member');
    await sharedProject(owner.page, 'Retrait');
    const url = await shareLink(owner.page, 'Éditeur');
    await joinThroughLink(member.page, url, 'Retrait');

    const dialog = await openShare(owner.page);
    const members = dialog.getByRole('list', { name: 'Membres' });
    await expect(members.getByRole('listitem')).toHaveCount(2);
    // The member's role can be lowered, then the member removed.
    await dialog.getByLabel('Rôle de member').selectOption({ label: 'Relecteur' });
    await expect(member.page.getByText('Relecteur', { exact: true })).toBeVisible();
    await members.getByRole('button', { name: 'Retirer' }).click();
    await owner.page
      .getByRole('dialog', { name: 'Retirer' })
      .getByRole('button', { name: 'Retirer' })
      .click();
    await expect(members.getByRole('listitem')).toHaveCount(1);

    await expect(member.page).toHaveURL(/\/projects$/);
    await expect(member.page.getByText("Vous n'avez plus accès à ce projet.")).toBeVisible();
  });
});
