import { expect, test } from '@playwright/test';
import { OAuth2Server } from 'oauth2-mock-server';
import { createProject } from '../editing.js';
import { createAccount, signIn, sql } from '../instance.js';

test('an administrator creates an account and limits its compile time', async ({ browser }) => {
  test.setTimeout(120_000);
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signIn(admin, createAccount('chief', { admin: true }));

  await admin.getByRole('link', { name: 'Administration' }).click();
  await expect(admin.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
  const username = `quota${String(Date.now())}`;
  await admin.getByRole('button', { name: 'Créer un compte' }).click();
  const create = admin.getByRole('dialog', { name: 'Nouveau compte' });
  await create.getByLabel('Nom affiché').fill('Quota');
  await create.getByLabel("Nom d'utilisateur").fill(username);
  await create.getByLabel('Adresse e-mail').fill(`${username}@example.org`);
  await create.getByRole('button', { name: 'Créer un compte' }).click();
  const password = await create.getByTestId('one-time-secret').inputValue();
  expect(password.length).toBeGreaterThanOrEqual(15);
  await create.getByRole('button', { name: 'Fermer' }).click();

  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  await signIn(user, { login: username, password });
  await createProject(user, 'Quota');
  const projectId = /\/projects\/([0-9a-f-]+)/.exec(user.url())?.[1] ?? '';

  // Two minutes of compilation already spent this month.
  sql(
    `insert into compile_runs (id, project_id, user_id, status, engine, main_file, options,
       manifest_digest, started_at, finished_at)
     select gen_random_uuid(), id, owner_id, 'success', 'pdflatex', 'main.tex',
       '{"draft":false,"haltOnError":false,"clean":false,"bibTool":"biber","shellEscape":"restricted"}',
       'e2e', now() - interval '2 minutes', now()
     from projects where id = '${projectId}'`,
  );

  await admin.getByLabel('Rechercher (nom, identifiant, adresse)').fill(username);
  const row = admin.getByTestId('admin-user-row').filter({ hasText: username });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Gérer' }).click();
  const manage = admin.getByRole('dialog', { name: 'Quota' });
  await manage.getByLabel('Compilation par mois (minutes)').fill('1');
  await manage.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(manage).toBeHidden();

  await user.getByRole('button', { name: 'Compiler', exact: true }).click();
  await expect(user.getByText('Votre temps de compilation du mois est épuisé.')).toBeVisible();

  await user.goto('/account');
  await expect(user.getByTestId('quotas')).toContainText('sur 1 minute');

  await adminContext.close();
  await userContext.close();
});

test('people sign in through the identity provider', async ({ page, request }) => {
  // The stack is started with this issuer in CI (.github/workflows/ci.yml).
  const issuer = process.env.OIDC_ISSUER;
  test.skip(issuer === undefined || issuer === '', 'no identity provider configured');
  const config = (await (await request.get('/api/auth/config')).json()) as {
    oidc: { displayName: string } | null;
  };
  test.skip(config.oidc === null, 'the instance has no identity provider');

  const provider = new OAuth2Server();
  await provider.issuer.keys.generate('RS256');
  const address = new URL(issuer ?? '');
  // Bound to every interface: the API container reaches it through the Docker host.
  await provider.start(Number(address.port), '0.0.0.0');
  provider.issuer.url = address.origin;
  // An account with the provider's verified address is linked on first sign-in.
  const { login: username } = createAccount('sso');
  provider.service.on('beforeTokenSigning', (token: { payload: Record<string, unknown> }) => {
    Object.assign(token.payload, {
      sub: username,
      email: `${username}@example.org`,
      email_verified: true,
      preferred_username: username,
      name: 'Personne SSO',
    });
  });
  try {
    await page.goto('/login');
    await page
      .getByRole('link', { name: `Se connecter avec ${config.oidc?.displayName ?? ''}` })
      .click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByText('Connecté en tant que sso')).toBeVisible();
  } finally {
    await provider.stop();
  }
});
