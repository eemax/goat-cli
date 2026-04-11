import { mkdir } from "node:fs/promises";

import { discoverRoots, loadGlobalConfig } from "./config.js";
import { loadDefinitions, loadModelCatalog } from "./defs.js";
import type { ProviderClient } from "./provider.js";

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type RuntimeDeps = {
  processCwd?: string;
  env?: NodeJS.ProcessEnv;
  createProvider?: (config: { apiKey: string; baseURL: string; timeoutSeconds: number }) => ProviderClient;
  fetchImpl?: FetchImpl;
};

export type BaseContext = {
  roots: Awaited<ReturnType<typeof discoverRoots>>;
  config: Awaited<ReturnType<typeof loadGlobalConfig>>;
};

export type AppContext = BaseContext & {
  models: Awaited<ReturnType<typeof loadModelCatalog>>;
  definitions: Awaited<ReturnType<typeof loadDefinitions>>;
};

export type CommandOutput = {
  stdout: string;
  /**
   * Final stderr payload for the command. Either an empty string or a
   * newline-terminated chunk; `main()` writes it verbatim when non-empty.
   */
  stderr: string;
  exitCode: number;
};

export async function loadBaseContext(processCwd: string, env: NodeJS.ProcessEnv): Promise<BaseContext> {
  const roots = await discoverRoots(processCwd, env);
  const config = await loadGlobalConfig(roots);
  await mkdir(config.paths.sessions_dir, { recursive: true });
  return {
    roots,
    config,
  };
}

export async function loadAppContext(baseContext: BaseContext): Promise<AppContext> {
  const { roots, config } = baseContext;
  const models = await loadModelCatalog(roots);
  const definitions = await loadDefinitions(roots, models);
  return {
    roots,
    config,
    models,
    definitions,
  };
}
