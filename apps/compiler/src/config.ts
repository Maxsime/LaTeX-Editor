import { compilerEnv, loadConfig, type CompilerConfig } from '@galley/shared';

export type { CompilerConfig };

/** Reads and validates the compiler worker configuration. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): CompilerConfig {
  return loadConfig(compilerEnv, env);
}
