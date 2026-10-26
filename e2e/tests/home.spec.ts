import { request as httpsRequest } from 'node:https';
import { expect, test } from '@playwright/test';
import { caCertificate, host, httpsPort, httpURL } from '../support.js';

test.describe('status page', () => {
  test('is served over HTTPS and reports every dependency as operational', async ({ page }) => {
    const cspViolations: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') cspViolations.push(message.text());
    });

    const response = await page.goto('/status');
    expect(response?.status()).toBe(200);
    expect(page.url()).toMatch(/^https:\/\//);
    expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");

    await expect(page.getByRole('heading', { level: 1, name: 'Galley' })).toBeVisible();
    const status = page.getByTestId('api-status');
    await expect(status).toHaveAttribute('data-state', 'ok');
    await expect(status.getByRole('listitem')).toHaveCount(3);
    await expect(status.getByText('Opérationnel')).toHaveCount(3);
    expect(cspViolations).toEqual([]);
  });

  test('switches language and remembers the choice', async ({ page }) => {
    await page.goto('/status');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.getByText('Éditeur LaTeX collaboratif auto-hébergé')).toBeVisible();

    await page.getByRole('radio', { name: 'English' }).click();
    await expect(page.getByText('Self-hosted collaborative LaTeX editor')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await page.reload();
    await expect(page.getByText('Self-hosted collaborative LaTeX editor')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'English' })).toHaveAttribute('data-state', 'on');
  });

  test('links to the source code (AGPL-3.0 §13)', async ({ page }) => {
    await page.goto('/status');
    await expect(page.getByRole('link', { name: 'Code source' })).toHaveAttribute(
      'href',
      /^https:\/\/github\.com\//,
    );
  });
});

test.describe('with an English browser', () => {
  test.use({ locale: 'en-US' });

  test('defaults to English', async ({ page }) => {
    await page.goto('/status');
    await expect(page.getByText('Self-hosted collaborative LaTeX editor')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});

test.describe('front proxy', () => {
  test('redirects HTTP to HTTPS', async ({ request }) => {
    const response = await request.get(`${httpURL}/`, { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toMatch(/^https:\/\//);
  });

  test('presents a certificate that chains to the local CA', async () => {
    // Strict verification with Node's TLS stack, independent of the browser flag.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpsRequest(
        { host, port: Number(httpsPort), path: '/api/health/live', ca: caCertificate },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  test('keeps internal probes and metrics private', async ({ request }) => {
    for (const path of ['/metrics', '/collab/metrics', '/collab/health/ready']) {
      const response = await request.get(path);
      expect(response.headers()['content-type'], path).toContain('text/html');
    }
  });

  test('answers unknown API routes with a typed error', async ({ request }) => {
    const response = await request.get('/api/does-not-exist');
    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(response.headers()['x-request-id']).toBeTruthy();
  });
});
