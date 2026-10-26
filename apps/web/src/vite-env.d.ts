/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the source code link shown in the footer, for forks. */
  readonly VITE_SOURCE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
