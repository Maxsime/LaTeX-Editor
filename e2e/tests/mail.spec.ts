import { expect, test } from '@playwright/test';
import { createAccount, signIn } from '../instance.js';
import { bodyOf, TestSmtpServer } from '../smtp.js';

test('a forgotten password is reset through the e-mailed link', async ({ page, request }) => {
  // The stack is started with this server in CI (.github/workflows/ci.yml).
  const smtpUrl = process.env.SMTP_URL;
  test.skip(smtpUrl === undefined || smtpUrl === '', 'no mail server configured');
  const config = (await (await request.get('/api/auth/config')).json()) as { mail: boolean };
  test.skip(!config.mail, 'the instance sends no e-mail');

  const smtp = new TestSmtpServer();
  await smtp.start(Number(new URL(smtpUrl ?? '').port));
  try {
    const account = createAccount('oubli');
    const address = `${account.login}@example.org`;
    await page.goto('/login');
    await page.getByRole('link', { name: 'Mot de passe oublié ?' }).click();
    await page.getByLabel('Adresse e-mail').fill(address);
    await page.getByRole('button', { name: 'Recevoir un lien' }).click();
    await expect(page.getByRole('status')).toContainText('Si un compte utilise cette adresse');

    const mail = await smtp.waitFor(address);
    const link = /https:\/\/\S+\/reset-password\?token=[A-Za-z0-9_-]+/.exec(bodyOf(mail))?.[0];
    expect(link).toBeDefined();
    const target = new URL(link ?? '');
    await page.goto(`${target.pathname}${target.search}`);
    await page.getByLabel('Nouveau mot de passe').fill('mot-de-passe-neuf-e2e');
    await page.getByLabel('Confirmer le mot de passe').fill('mot-de-passe-neuf-e2e');
    await page.getByRole('button', { name: 'Enregistrer le mot de passe' }).click();
    await expect(page.getByRole('status')).toContainText('Mot de passe modifié');

    // The link works once.
    await page.goto(`${target.pathname}${target.search}`);
    await page.getByLabel('Nouveau mot de passe').fill('encore-un-autre-e2e');
    await page.getByLabel('Confirmer le mot de passe').fill('encore-un-autre-e2e');
    await page.getByRole('button', { name: 'Enregistrer le mot de passe' }).click();
    await expect(page.getByRole('alert')).toContainText("Ce lien n'est plus valable");

    await signIn(page, { login: account.login, password: 'mot-de-passe-neuf-e2e' });
  } finally {
    await smtp.stop();
  }
});

test('mention e-mails can be turned off from the account page', async ({ page, request }) => {
  const config = (await (await request.get('/api/auth/config')).json()) as { mail: boolean };
  test.skip(!config.mail, 'the instance sends no e-mail');
  await signIn(page, createAccount('notif'));
  await page.goto('/account');
  const toggle = page.getByLabel("M'envoyer un e-mail quand un commentaire me mentionne");
  await expect(toggle).toBeChecked();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/me/notifications') && response.request().method() === 'PATCH',
  );
  await toggle.click();
  await saved;
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(toggle).not.toBeChecked();
});
