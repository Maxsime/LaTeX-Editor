import { defineConfig, devices } from '@playwright/test';
import { baseURL, caCertificate, intermediateCertificate, spkiHash } from './support.js';

export default defineConfig({
  testDir: './tests',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        locale: 'fr-FR',
        launchOptions: {
          // Trust exactly the instance's local CA rather than ignoring certificate errors:
          // Chromium matches these keys against the chain the server presents, so a
          // certificate issued by anyone else still fails.
          args: [
            `--ignore-certificate-errors-spki-list=${[caCertificate, intermediateCertificate].map(spkiHash).join(',')}`,
          ],
        },
      },
    },
  ],
});
