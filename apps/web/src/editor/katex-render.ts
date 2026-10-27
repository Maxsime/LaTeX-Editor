import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * Renders a formula into `target`. Loaded on the first hover only: KaTeX and
 * its fonts are not needed to edit. `katex.render` sets styles through the
 * CSSOM, which the page's style-src policy allows, unlike inline style markup.
 */
export function renderFormula(
  tex: string,
  display: boolean,
  macros: Record<string, string>,
  target: HTMLElement,
): void {
  katex.render(tex, target, {
    displayMode: display,
    throwOnError: true,
    // A copy: KaTeX adds the formula's own \def's to the object it is given.
    macros: { ...macros },
    // No \href, \includegraphics or \htmlClass from shared documents.
    trust: false,
    strict: 'ignore',
    maxSize: 20,
    maxExpand: 500,
  });
}
