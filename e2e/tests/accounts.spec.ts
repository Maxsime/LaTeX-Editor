import { expect, test } from '@playwright/test';
import { adminCli, createAccount, setupCodeFromLogs, signIn } from '../instance.js';

test.describe.configure({ mode: 'serial' });

test.describe('accounts', () => {
  test('first run: the administrator account needs the setup code', async ({ page, request }) => {
    // Shape fixed by authConfigResponse in packages/shared.
    const config = (await (await request.get('/api/auth/config')).json()) as {
      setupRequired: boolean;
    };
    test.skip(!config.setupRequired, 'instance already set up');

    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel("Code d'installation").fill('wrong-code');
    await page.getByLabel('Nom affiché').fill('Administratrice');
    await page.getByLabel('Adresse e-mail').fill('admin@example.org');
    await page.getByLabel("Nom d'utilisateur").fill('admin');
    await page.getByLabel('Mot de passe').fill('admin-password-e2e');
    await page.getByRole('button', { name: 'Créer le compte administrateur' }).click();
    await expect(page.getByRole('alert')).toHaveText('Accès refusé.');

    await page.getByLabel("Code d'installation").fill(setupCodeFromLogs());
    await page.getByRole('button', { name: 'Créer le compte administrateur' }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByText('Connecté en tant que Administratrice')).toBeVisible();
  });

  test('registration is by invitation by default', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByText('Les inscriptions se font sur invitation.')).toBeVisible();

    const link = /(\/register\?invite=\S+)/.exec(adminCli(['create-invite', '--days', '1']))?.[1];
    expect(link).toBeDefined();
    const username = `invitee${String(Date.now())}`;
    await page.goto(link ?? '');
    await page.getByLabel('Nom affiché').fill('Invitée');
    await page.getByLabel('Adresse e-mail').fill(`${username}@example.org`);
    await page.getByLabel("Nom d'utilisateur").fill(username);
    await page.getByLabel('Mot de passe').fill('short');
    await page.getByRole('button', { name: 'Créer le compte' }).click();
    // The browser blocks the submission until the password is long enough.
    await expect(page).toHaveURL(/\/register/);
    await page.getByLabel('Mot de passe').fill(`${username}-password`);
    await page.getByRole('button', { name: 'Créer le compte' }).click();
    await expect(page).toHaveURL(/\/projects$/);

    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page, { login: `${username}@example.org`, password: `${username}-password` });
  });

  test('refuses wrong credentials without telling which part is wrong', async ({ page }) => {
    const account = createAccount('login');
    await page.goto('/login');
    await page.getByLabel("Adresse e-mail ou nom d'utilisateur").fill(account.login);
    await page.getByLabel('Mot de passe').fill('not-the-password');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page.getByRole('alert')).toHaveText('Connexion requise.');
    await signIn(page, account);
  });

  test('sends signed-out visitors to the sign-in page', async ({ page }) => {
    await page.goto('/projects');
    await expect(page).toHaveURL(/\/login$/);
  });
});
