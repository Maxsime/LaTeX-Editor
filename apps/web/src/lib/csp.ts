/**
 * Nonce of the page's style policy, which Caddy writes into index.html on
 * every response. Libraries that add style elements (CodeMirror, the scroll
 * lock of dialogs) are refused by the CSP without it. In development the page
 * has no policy, the template stays unfilled, and no nonce is used.
 */
export function styleNonce(doc: Document = document): string | null {
  const content = doc.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '';
  return /^[\w-]+$/.test(content) ? content : null;
}
