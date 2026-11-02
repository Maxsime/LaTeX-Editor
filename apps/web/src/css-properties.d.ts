import 'react';

declare module 'react' {
  /** Custom properties the page sets on elements (see styles.css and PaneSplitter). */
  interface CSSProperties {
    '--editor-fr'?: string;
    '--pdf-fr'?: string;
  }
}
