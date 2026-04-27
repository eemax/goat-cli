import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore } from "../src/artifacts.js";
import type { ToolContext } from "../src/harness.js";
import type { ProviderClient, ProviderRequest, ProviderTurnResult } from "../src/provider.js";
import type { GlobalConfig } from "../src/types.js";

export class FakeProvider implements ProviderClient {
  public readonly requests: ProviderRequest[] = [];

  public constructor(private readonly turns: ProviderTurnResult[]) {}

  public async runTurn(request: ProviderRequest): Promise<ProviderTurnResult> {
    this.requests.push(request);
    const next = this.turns.shift();
    if (!next) {
      throw new Error("no fake provider turn queued");
    }
    return next;
  }
}

export const testToolsConfig: GlobalConfig["tools"] = {
  default_shell: "/bin/bash",
  default_shell_args: ["-lc"],
  max_output_chars: 200,
  max_file_size: 1 * 1024 * 1024,
  web_search: {
    api_key: null,
    api_key_env: "EXA_API_KEY",
    base_url: "https://api.exa.ai",
    type: "auto",
  },
  web_fetch: {
    block_private_hosts: true,
    command: "defuddle",
    timeout: 45,
  },
};

const testArtifactsConfig: GlobalConfig["artifacts"] = {
  preview_limit: 50 * 1024,
  catastrophic_output_limit: 4096,
};

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export function useCleanup(): { track: (...pathsToTrack: string[]) => void; paths: string[] } {
  const paths: string[] = [];

  afterEach(async () => {
    while (paths.length > 0) {
      const path = paths.pop();
      if (path) {
        await rm(path, { recursive: true, force: true });
      }
    }
  });

  return {
    track: (...pathsToTrack: string[]) => paths.push(...pathsToTrack),
    paths,
  };
}

/**
 * Build a ToolContext rooted at a fresh tempdir. Used by tools/agent/harness
 * tests that need a realistic run cwd and artifact store without setting up a
 * full session on disk.
 */
export async function createToolContextFixture(options?: {
  planMode?: boolean;
  tempPrefix?: string;
  track?: (...paths: string[]) => void;
  mutationLockTracker?: { count: number };
  config?: GlobalConfig["tools"];
  catastrophicOutputLimit?: number;
}): Promise<ToolContext> {
  const runRoot = await createTempDir(options?.tempPrefix ?? "goat-ctx-");
  options?.track?.(runRoot);
  const cwd = join(runRoot, "workspace");
  const artifactsDir = join(runRoot, "artifacts");
  await mkdir(cwd, { recursive: true });
  const lockTracker = options?.mutationLockTracker;
  return {
    cwd,
    planMode: options?.planMode ?? false,
    config: options?.config ?? testToolsConfig,
    catastrophicOutputLimit: options?.catastrophicOutputLimit ?? testArtifactsConfig.catastrophic_output_limit,
    artifacts: new ArtifactStore(artifactsDir),
    runRoot,
    ensureMutationLock: async () => {
      if (lockTracker) {
        lockTracker.count += 1;
      }
    },
  };
}
