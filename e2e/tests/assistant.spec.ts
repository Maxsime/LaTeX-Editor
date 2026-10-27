import { expect, test } from '@playwright/test';
// The fake speaks the real OpenAI streaming protocol, as Ollama does; shared with the API tests.
import {
  type FakeProvider,
  type FakeTurn,
  startFakeProvider,
} from '../../packages/ai/src/testing/fake-provider.js';
import { createProject, editor, open, synced, upload } from '../editing.js';
import { createAccount, signIn } from '../instance.js';

const KEY = 'sk-e2e-fake-key-7Qp4';

const SCRIPT: FakeTurn[] = [
  { toolCalls: [{ name: 'read_file', input: { path: 'main.tex' } }] },
  {
    toolCalls: [
      {
        name: 'propose_changes',
        input: {
          edits: [{ path: 'main.tex', search: 'Bonjour le monde.', replace: 'Bonjour à tous.' }],
        },
      },
    ],
  },
  { text: 'Je propose une formule plus chaleureuse.' },
  // Inline edit.
  { text: '```latex\nUn second paragraphe plus court.\n```' },
  // Generation.
  { text: '```latex\n\\begin{tabular}{cc}\n  a & b \\\\\n\\end{tabular}\n```' },
];

let fake: FakeProvider;

test.beforeAll(async () => {
  // Bound to every interface: the API container reaches it through host.docker.internal.
  fake = await startFakeProvider('openai', SCRIPT, '0.0.0.0');
});

test.afterAll(async () => {
  await fake.close();
});

test('the assistant proposes changes that apply only once accepted', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, createAccount('assistant'));

  // Personal configuration: a local model behind an OpenAI-compatible address.
  await page.goto('/account');
  const section = page.getByRole('region', { name: 'Assistant IA' });
  await section.getByLabel('Fournisseur').selectOption('openai-compatible');
  await section.getByLabel('Modèle').fill('fake-model');
  const address = new URL(fake.url);
  address.hostname = 'host.docker.internal';
  await section.getByLabel('Adresse du serveur').fill(address.href);
  await section.getByLabel("Clé d'API", { exact: true }).fill(KEY);
  await section.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(section.getByText(`Clé enregistrée : …${KEY.slice(-4)}`)).toBeVisible();
  // The key is never sent back, even masked beyond its last characters.
  expect(await page.content()).not.toContain(KEY);

  await page.goto('/projects');
  await createProject(page, 'Assistant');
  await upload(page, {
    'main.tex': [
      '\\documentclass{article}',
      '\\begin{document}',
      'Bonjour le monde.',
      '',
      'Second paragraphe un peu trop long.',
      '\\end{document}',
      '',
    ].join('\n'),
  });
  await open(page, 'main.tex');

  await page.getByRole('tab', { name: 'Assistant' }).click();
  await page.getByLabel("Message à l'assistant").fill('Rends la salutation plus chaleureuse.');
  await page.getByRole('button', { name: 'Envoyer' }).click();

  const card = page.getByTestId('ai-changeset');
  await expect(card).toContainText('Bonjour à tous.');
  await expect(page.getByTestId('ai-answer').last()).toContainText('formule plus chaleureuse');
  await expect(page.getByTestId('ai-tool').first()).toContainText('main.tex');
  await expect(page.getByTestId('ai-usage').first()).toBeVisible();
  expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);

  // Proposed, not written: the file still holds the original sentence.
  await expect(page.getByTestId('ai-inline-proposal')).toContainText('Bonjour à tous.');
  await expect(editor(page)).toContainText('Bonjour le monde.');

  await card.getByRole('button', { name: 'Accepter' }).click();
  await expect(card.getByTestId('ai-hunk')).toHaveAttribute('data-status', 'applied');
  await expect(editor(page)).toContainText('Bonjour à tous.');
  await expect(editor(page)).not.toContainText('Bonjour le monde.');
  await expect(page.getByTestId('ai-inline-proposal')).toHaveCount(0);

  // Inline edit of a selection, accepted from the editor itself.
  await editor(page).getByText('Second paragraphe un peu trop long.').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Control+Alt+k');
  await page.getByLabel(/^Consigne/).fill('Plus court');
  await page.getByRole('button', { name: 'Proposer' }).click();
  const proposal = page.getByTestId('ai-inline-proposal');
  await expect(proposal).toContainText('Un second paragraphe plus court.');
  await expect(editor(page)).toContainText('Second paragraphe un peu trop long.');
  await proposal.getByRole('button', { name: 'Accepter' }).click();
  await expect(editor(page)).toContainText('Un second paragraphe plus court.');
  await expect(editor(page)).not.toContainText('trop long');
  await synced(page);

  // Generation from a description: compiled alone for the preview, inserted on request.
  await page.keyboard.press('Control+End');
  await page.getByRole('button', { name: 'Générer…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Type').selectOption('table');
  await dialog.getByLabel('Description').fill('Un tableau de deux colonnes');
  await dialog.getByRole('button', { name: 'Générer' }).click();
  await expect(dialog.getByTestId('ai-snippet')).toHaveAttribute('data-outcome', 'success', {
    timeout: 60_000,
  });
  const preview = dialog.getByTestId('pdf-viewer');
  await expect(preview).not.toHaveAttribute('data-url', '');
  await expect(preview).not.toHaveAttribute('data-pages', '0');
  await expect(dialog.getByTestId('ai-snippet-code')).toHaveValue(/\\begin\{tabular\}/);
  await dialog.getByRole('button', { name: 'Insérer au curseur' }).click();
  await expect(dialog).toBeHidden();
  await expect(editor(page)).toContainText('\\begin{tabular}{cc}');
  await synced(page);
});
