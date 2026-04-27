import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { executeToolCall, exportProviderTools, runProcess } from "../src/harness.js";
import type { GlobalConfig } from "../src/types.js";
import { createToolContextFixture, testToolsConfig, useCleanup } from "./helpers.js";

const { track } = useCleanup();

async function createContext(planMode = false, catastrophicOutputLimit?: number, config?: GlobalConfig["tools"]) {
  return createToolContextFixture({
    planMode,
    tempPrefix: "goat-run-",
    track,
    catastrophicOutputLimit,
    config,
  });
}

async function withJsonServer(
  handler: (request: {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }) => unknown,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const result = handler({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe("tool registry", () => {
  test("exports provider tool schemas", () => {
    const tools = exportProviderTools(["read_file", "write_file", "bash"]);
    expect(tools.map((tool) => tool.name)).toEqual(["read_file", "write_file", "bash"]);
    expect(tools[0]?.parameters).toHaveProperty("type", "object");
  });
});

describe("file tools", () => {
  test("reads, writes, and replaces file content", async () => {
    const context = await createContext();
    const target = join(context.cwd, "note.txt");

    const writeResult = await executeToolCall(context, ["write_file", "read_file", "replace_in_file"], "write_file", {
      path: "note.txt",
      content: "hello world",
    });
    expect(writeResult.ok).toBe(true);

    const readResult = await executeToolCall(context, ["write_file", "read_file", "replace_in_file"], "read_file", {
      path: "note.txt",
    });
    expect(readResult.ok).toBe(true);
    expect(readResult.ok && readResult.data?.content).toBe("hello world");

    const replaceResult = await executeToolCall(
      context,
      ["write_file", "read_file", "replace_in_file"],
      "replace_in_file",
      {
        path: "note.txt",
        old_text: "world",
        new_text: "goat",
      },
    );
    expect(replaceResult.ok).toBe(true);
    expect(await readFile(target, "utf8")).toBe("hello goat");
  });

  test("returns planned results for mutating file tools", async () => {
    const context = await createContext(true);
    const result = await executeToolCall(context, ["write_file"], "write_file", {
      path: "note.txt",
      content: "hello",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.planned).toBe(true);
  });
});

describe("search tools", () => {
  test("glob and grep use rg and return structured results", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "one.ts"), "export const one = 1;\n");
    await writeFile(join(context.cwd, "two.ts"), "export const two = 2;\n");

    const globResult = await executeToolCall(context, ["glob", "grep"], "glob", {
      pattern: "*.ts",
    });
    expect(globResult.ok).toBe(true);
    // rg --files does not guarantee ordering, so compare as a set.
    const matches = globResult.ok ? ((globResult.data?.matches as string[] | undefined) ?? []) : [];
    expect([...matches].sort()).toEqual(["one.ts", "two.ts"]);

    const grepResult = await executeToolCall(context, ["glob", "grep"], "grep", {
      pattern: "two",
    });
    expect(grepResult.ok).toBe(true);
    expect(grepResult.ok && Array.isArray(grepResult.data?.matches)).toBe(true);
  });

  test("web_search posts the configured Exa shape and returns compact results", async () => {
    const captured: Array<{
      method?: string;
      url?: string;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> = [];
    const server = await withJsonServer((request) => {
      captured.push(request);
      return {
        searchType: "neural",
        results: [
          {
            url: "https://example.com/post",
            title: " Example   Post ",
            publishedDate: "2026-04-01",
            score: 0.92,
            highlights: [" First   highlight ", ""],
          },
        ],
      };
    });
    try {
      const context = await createContext(false, undefined, {
        ...testToolsConfig,
        web_search: {
          ...testToolsConfig.web_search,
          api_key: "test-exa-key",
          base_url: server.baseUrl,
          type: "neural",
        },
        max_output_chars: 10_000,
      });
      const result = await executeToolCall(context, ["web_search"], "web_search", {
        query: " rust async runtimes ",
        num_results: 3,
        published_within_days: 30,
        include_domains: ["Example.com", "example.com"],
      });

      expect(result.ok).toBe(true);
      expect(captured[0]?.method).toBe("POST");
      expect(captured[0]?.url).toBe("/search");
      expect(captured[0]?.headers["x-api-key"]).toBe("test-exa-key");
      const body = JSON.parse(captured[0]?.body ?? "{}");
      expect(body).toMatchObject({
        query: "rust async runtimes",
        type: "neural",
        numResults: 3,
        includeDomains: ["example.com"],
        contents: { highlights: {} },
      });
      expect(typeof body.startPublishedDate).toBe("string");
      expect(result.ok && result.data?.type).toBe("neural");
      expect(result.ok && result.data?.result_count).toBe(1);
      const results = result.ok ? (result.data?.results as Array<Record<string, unknown>>) : [];
      expect(results[0]).toMatchObject({
        url: "https://example.com/post",
        title: "Example Post",
        published_date: "2026-04-01",
        score: 0.92,
        highlights: ["First highlight"],
      });
    } finally {
      await server.close();
    }
  });

  test("web_search hides Exa mode from the model-facing schema", () => {
    const [tool] = exportProviderTools(["web_search"]);
    const parameters = tool?.parameters as { properties?: Record<string, unknown> };
    expect(parameters.properties).not.toHaveProperty("type");
  });

  test("web_search validates credentials and domain overlap", async () => {
    const context = await createContext(false, undefined, {
      ...testToolsConfig,
      web_search: {
        ...testToolsConfig.web_search,
        api_key_env: "GOAT_TEST_MISSING_EXA_API_KEY",
      },
    });
    const missingKey = await executeToolCall(context, ["web_search"], "web_search", {
      query: "hello",
    });
    expect(missingKey.ok).toBe(false);
    expect(missingKey.ok ? null : missingKey.error.message).toContain("missing Exa API key");

    const overlapContext = await createContext(false, undefined, {
      ...testToolsConfig,
      web_search: {
        ...testToolsConfig.web_search,
        api_key: "test-exa-key",
      },
    });
    const overlap = await executeToolCall(overlapContext, ["web_search"], "web_search", {
      query: "hello",
      include_domains: ["example.com"],
      exclude_domains: ["EXAMPLE.com"],
    });
    expect(overlap.ok).toBe(false);
    expect(overlap.ok ? null : overlap.error.message).toContain("overlap");
  });
});

describe("web fetch tool", () => {
  test("web_fetch invokes the configured defuddle CLI and returns markdown", async () => {
    const binDir = join((await createContext()).runRoot, "bin");
    await mkdir(binDir, { recursive: true });
    const defuddle = join(binDir, "defuddle");
    await writeFile(defuddle, '#!/bin/sh\nprintf \'# Title\\n\\nFetched %s with %s\\n\' "$2" "$3"\n');
    await chmod(defuddle, 0o755);
    const context = await createContext(false, undefined, {
      ...testToolsConfig,
      web_fetch: {
        ...testToolsConfig.web_fetch,
        block_private_hosts: false,
        command: defuddle,
      },
    });

    const result = await executeToolCall(context, ["web_fetch"], "web_fetch", {
      url: "https://example.com/docs",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.mode).toBe("defuddle");
    expect(result.ok && result.data?.content).toBe("# Title\n\nFetched https://example.com/docs with --md");
  });

  test("web_fetch blocks private hosts before running defuddle", async () => {
    const context = await createContext(false, undefined, {
      ...testToolsConfig,
      web_fetch: {
        ...testToolsConfig.web_fetch,
        command: "/bin/false",
      },
    });

    const result = await executeToolCall(context, ["web_fetch"], "web_fetch", {
      url: "http://127.0.0.1/secret",
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.message).toContain("private host");
  });
});

describe("bash tool", () => {
  test("runs shell commands in normal mode", async () => {
    const context = await createContext();
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "printf 'hi'",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.stdout).toBe("hi");
  });

  test("restricts plan-mode commands and executes read-only subset", async () => {
    const context = await createContext(true);
    await writeFile(join(context.cwd, "note.txt"), "hello\n");
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "cat note.txt",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.stdout).toBe("hello\n");

    const invalid = await executeToolCall(context, ["bash"], "bash", {
      command: "echo hello > note.txt",
    });
    expect(invalid.ok).toBe(false);

    const dangerousRg = await executeToolCall(context, ["bash"], "bash", {
      command: "rg --pre /bin/echo hello .",
    });
    expect(dangerousRg.ok).toBe(false);
  });

  test("allows safe git and rg commands in plan mode", async () => {
    const context = await createContext(true);
    await writeFile(join(context.cwd, "note.txt"), "goat\n");
    await runProcess("git", ["init", "-q"], { cwd: context.cwd });

    const gitStatus = await executeToolCall(context, ["bash"], "bash", {
      command: "git status --short",
    });
    expect(gitStatus.ok).toBe(true);

    const rgResult = await executeToolCall(context, ["bash"], "bash", {
      command: "rg -n goat note.txt",
    });
    expect(rgResult.ok).toBe(true);
    expect(rgResult.ok && rgResult.data?.stdout).toContain("1:goat");
  });

  test("rejects unsafe plan-mode command patterns and override inputs", async () => {
    const context = await createContext(true);
    await writeFile(join(context.cwd, "note.txt"), "hello\n");

    const disallowedCommands = [
      {
        command: "git push",
        message: "unsupported git subcommand",
      },
      {
        command: "FOO=bar cat note.txt",
        message: "inline environment assignment",
      },
      {
        command: 'cat "note.txt',
        message: "unterminated quote",
      },
    ];

    for (const testCase of disallowedCommands) {
      const result = await executeToolCall(context, ["bash"], "bash", {
        command: testCase.command,
      });
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.error.message).toContain(testCase.message);
    }

    const envOverride = await executeToolCall(context, ["bash"], "bash", {
      command: "cat note.txt",
      env: {
        FOO: "bar",
      },
    });
    expect(envOverride.ok).toBe(false);
    expect(envOverride.ok ? null : envOverride.error.message).toContain("env overrides");

    const shellOverride = await executeToolCall(context, ["bash"], "bash", {
      command: "cat note.txt",
      shell: "/bin/sh",
    });
    expect(shellOverride.ok).toBe(false);
    expect(shellOverride.ok ? null : shellOverride.error.message).toContain("shell overrides");
  });

  test("returns error envelopes for non-zero shell exits in normal mode", async () => {
    const context = await createContext();
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: "exit 7",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("SHELL_COMMAND_FAILED");
    expect(result.ok ? null : result.error.message).toContain("command exited with 7");
  });

  test("fails explicitly when command output exceeds the catastrophic limit", async () => {
    const context = await createContext(false, 128);
    const result = await executeToolCall(context, ["bash"], "bash", {
      command: 'i=0; while [ "$i" -lt 500 ]; do printf x; i=$((i+1)); done',
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("OUTPUT_LIMIT_EXCEEDED");
    expect(result.ok ? null : result.error.message).toContain("catastrophic_output_limit");
  });
});

describe("patch tool", () => {
  test("applies structured patches", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "note.txt"), "hello\nworld\n");
    const patch = `*** Begin Patch
*** Update File: note.txt
@@
 hello
-world
+goat
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", {
      patch,
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(context.cwd, "note.txt"), "utf8")).toBe("hello\ngoat\n");
  });

  test("accepts trailing newline after end marker and rename-only updates", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "note.txt"), "hello\n");

    const renamePatch = `*** Begin Patch
*** Update File: note.txt
*** Move to: renamed.txt
*** End Patch
`;
    const renameResult = await executeToolCall(context, ["apply_patch"], "apply_patch", {
      patch: renamePatch,
    });

    expect(renameResult.ok).toBe(true);
    expect(await readFile(join(context.cwd, "renamed.txt"), "utf8")).toBe("hello\n");
  });

  test("applies multi-hunk patches", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "multi.txt"), "aaa\nbbb\nccc\nddd\neee\n");
    const patch = `*** Begin Patch
*** Update File: multi.txt
@@
 aaa
-bbb
+BBB
@@
 ddd
-eee
+EEE
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(true);
    expect(await readFile(join(context.cwd, "multi.txt"), "utf8")).toBe("aaa\nBBB\nccc\nddd\nEEE\n");
  });

  test("deletes files via patch", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "doomed.txt"), "goodbye\n");
    const patch = `*** Begin Patch
*** Delete File: doomed.txt
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(true);
    await expect(stat(join(context.cwd, "doomed.txt"))).rejects.toThrow();
  });

  test("adds new files via patch", async () => {
    const context = await createContext();
    const patch = `*** Begin Patch
*** Add File: brand-new.txt
+line one
+line two
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(true);
    expect(await readFile(join(context.cwd, "brand-new.txt"), "utf8")).toBe("line one\nline two\n");
  });

  test("rejects patch when context does not match file content", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "note.txt"), "actual content\n");
    const patch = `*** Begin Patch
*** Update File: note.txt
@@
 wrong context
-actual content
+replaced
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.message).toContain("did not match");
  });

  test("rejects patch when hunk matches multiple locations", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "dup.txt"), "aaa\nbbb\naaa\nbbb\n");
    const patch = `*** Begin Patch
*** Update File: dup.txt
@@
 aaa
-bbb
+ccc
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.message).toContain("multiple locations");
  });

  test("anchors patch to end of file with End of File marker", async () => {
    const context = await createContext();
    await writeFile(join(context.cwd, "eof.txt"), "first\nsecond\nthird\n");
    const patch = `*** Begin Patch
*** Update File: eof.txt
@@
 second
-third
+THIRD
*** End of File
*** End Patch`;
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", { patch });
    expect(result.ok).toBe(true);
    expect(await readFile(join(context.cwd, "eof.txt"), "utf8")).toBe("first\nsecond\nTHIRD\n");
  });

  test("rejects empty patches", async () => {
    const context = await createContext();
    const result = await executeToolCall(context, ["apply_patch"], "apply_patch", {
      patch: `*** Begin Patch
*** End Patch`,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.message).toContain("at least one hunk");
  });
});
