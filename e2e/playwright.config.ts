import { defineConfig, devices } from '@playwright/test';
import { baseURL, caCertificate, intermediateCertificate, spkiHash } from './support.js';

const browser = {
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
};

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
      // Measurements run apart (see `perf` below).
      grepInvert: /@perf/,
      use: browser,
    },
    {
      // Timing tests; scripts/run.js starts them once every other test is done.
      name: 'perf',
      grep: /@perf/,
      use: browser,
    },
  ],
});
