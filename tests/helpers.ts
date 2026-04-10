import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    enabled: false,
    api_key: null,
    api_key_env: "EXA_API_KEY",
  },
  web_fetch: {
    enabled: false,
    block_private_hosts: true,
    defuddle_base_url: null,
  },
  subagents: {
    enabled: false,
    default_model: "gpt-5.4-mini",
  },
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
