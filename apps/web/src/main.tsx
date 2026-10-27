import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { setNonce } from 'get-nonce';
import { createRoot } from 'react-dom/client';
import './i18n/index.js';
import { styleNonce } from './lib/csp.js';
import { router } from './router.js';
import './styles.css';

// Dialogs lock page scrolling with a style element, which needs the CSP nonce.
const nonce = styleNonce();
if (nonce !== null) setNonce(nonce);

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
