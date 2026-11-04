import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { setNonce } from 'get-nonce';
import { createRoot } from 'react-dom/client';
import './i18n/index.js';
import { styleNonce } from './lib/csp.js';
import { browserReloadEnvironment, reloadForStaleChunk } from './lib/stale-chunk.js';
import { followTheme } from './lib/theme.js';
import { router } from './router.js';
import './styles.css';

// Dialogs lock page scrolling with a style element, which needs the CSP nonce.
const nonce = styleNonce();
if (nonce !== null) setNonce(nonce);

followTheme();

// A chunk of the previous version is gone after an upgrade: reload once, quietly.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForStaleChunk(browserReloadEnvironment())) event.preventDefault();
});

const queryClient = new QueryClient();
const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
