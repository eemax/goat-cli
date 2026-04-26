import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { GoatError, toolError } from "./errors.js";
import type { ToolContext } from "./harness.js";
import { maybeArtifactForText, runProcess } from "./harness.js";
import type { ToolEnvelope } from "./types.js";

const DEFAULT_NUM_RESULTS = 5;
const SEARCH_TIMEOUT_MS_BY_TYPE = {
  auto: 15_000,
  neural: 10_000,
  deep: 60_000,
} as const;

type WebSearchInput = {
  query: string;
  num_results?: number;
  published_within_days?: number;
  include_domains?: string[];
  exclude_domains?: string[];
};

type WebFetchInput = {
  url: string;
};

type ExaSearchResult = {
  url?: unknown;
  title?: unknown;
  publishedDate?: unknown;
  score?: unknown;
  highlights?: unknown;
};

type ExaSearchResponse = {
  results?: unknown;
  searchType?: unknown;
};

function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeWhitespace(value);
  return normalized.length > 0 ? normalized : undefined;
}

function compactStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const normalized = compactOptionalString(item);
    return normalized ? [normalized] : [];
  });
}

function normalizeDomains(domains: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const domain of domains ?? []) {
    const value = domain.trim().toLowerCase();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function ensureNoDomainOverlap(includeDomains: string[], excludeDomains: string[]): void {
  const excludes = new Set(excludeDomains);
  const overlapping = includeDomains.filter((domain) => excludes.has(domain));
  if (overlapping.length > 0) {
    throw toolError(`include_domains and exclude_domains overlap: ${overlapping.join(", ")}`);
  }
}

function startPublishedDate(days: number | undefined): string | undefined {
  if (days === undefined) {
    return undefined;
  }
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function buildSearchRequest(context: ToolContext, input: WebSearchInput): Record<string, unknown> {
  const includeDomains = normalizeDomains(input.include_domains);
  const excludeDomains = normalizeDomains(input.exclude_domains);
  ensureNoDomainOverlap(includeDomains, excludeDomains);

  const request: Record<string, unknown> = {
    query: input.query.trim(),
    type: context.config.web_search.type,
    numResults: input.num_results ?? DEFAULT_NUM_RESULTS,
    contents: {
      highlights: {},
    },
  };
  if (includeDomains.length > 0) {
    request.includeDomains = includeDomains;
  }
  if (excludeDomains.length > 0) {
    request.excludeDomains = excludeDomains;
  }
  const publishedDate = startPublishedDate(input.published_within_days);
  if (publishedDate) {
    request.startPublishedDate = publishedDate;
  }
  return request;
}

function resolveExaApiKey(context: ToolContext): string {
  const key = context.config.web_search.api_key ?? process.env[context.config.web_search.api_key_env];
  if (!key?.trim()) {
    throw toolError(`missing Exa API key; set tools.web_search.api_key or ${context.config.web_search.api_key_env}`);
  }
  return key.trim();
}

function compactSearchResult(result: ExaSearchResult): Record<string, unknown> | null {
  if (typeof result.url !== "string" || result.url.trim().length === 0) {
    return null;
  }
  const output: Record<string, unknown> = {
    url: result.url.trim(),
  };
  const title = compactOptionalString(result.title);
  if (title) {
    output.title = title;
  }
  const publishedDate = compactOptionalString(result.publishedDate);
  if (publishedDate) {
    output.published_date = publishedDate;
  }
  if (typeof result.score === "number" && Number.isFinite(result.score)) {
    output.score = result.score;
  }
  const highlights = compactStringArray(result.highlights);
  if (highlights.length > 0) {
    output.highlights = highlights;
  }
  return output;
}

function buildSearchOutput(query: string, requestedType: string, requestedCount: number, response: ExaSearchResponse) {
  const effectiveType =
    typeof response.searchType === "string" && response.searchType.trim() ? response.searchType.trim() : requestedType;
  const rawResults = Array.isArray(response.results) ? response.results : [];
  const results = rawResults.flatMap((entry) => {
    const result = compactSearchResult(entry as ExaSearchResult);
    return result ? [result] : [];
  });
  return {
    query,
    type: effectiveType,
    ...(effectiveType !== requestedType ? { requested_type: requestedType } : {}),
    num_results: requestedCount,
    results,
    result_count: results.length,
  };
}

function formatResponseBody(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : "(empty response body)";
}

export async function runWebSearchTool(context: ToolContext, input: WebSearchInput): Promise<ToolEnvelope> {
  if (!input.query.trim()) {
    throw toolError("tool argument `query` must be a non-empty string");
  }
  const apiKey = resolveExaApiKey(context);
  const request = buildSearchRequest(context, input);
  const timeoutMs = SEARCH_TIMEOUT_MS_BY_TYPE[context.config.web_search.type];
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  timeout.unref();
  const onAbort = () => abortController.abort(context.abortSignal?.reason);
  context.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(`${context.config.web_search.base_url.replace(/\/+$/, "")}/search`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: abortController.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw toolError(`exa /search returned HTTP ${response.status}: ${formatResponseBody(body)}`);
    }

    let parsed: ExaSearchResponse;
    try {
      parsed = JSON.parse(body) as ExaSearchResponse;
    } catch (error) {
      throw toolError(
        `failed to decode exa /search response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const output = buildSearchOutput(
      input.query.trim(),
      context.config.web_search.type,
      (request.numResults as number | undefined) ?? DEFAULT_NUM_RESULTS,
      parsed,
    );
    const inline = JSON.stringify(output, null, 2);
    const artifactDecision = await maybeArtifactForText(context, "web-search", inline, "application/json");
    return {
      ok: true,
      summary: `Found ${output.result_count} search results for "${output.query}".`,
      data: artifactDecision.partial
        ? {
            partial: true,
            truncation_reason: "max_output_chars_exceeded",
            preview: artifactDecision.preview,
            artifact: artifactDecision.artifact,
          }
        : output,
    };
  } catch (error) {
    if (error instanceof GoatError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw toolError(`exa /search timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw toolError(`exa /search request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
    context.abortSignal?.removeEventListener("abort", onAbort);
  }
}

function parseFetchUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw toolError(`invalid URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw toolError("web_fetch only supports http and https URLs");
  }
  if (url.username || url.password) {
    throw toolError("web_fetch URLs must not contain embedded credentials");
  }
  return url;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPrivateIpv4(address);
  }
  if (family === 6) {
    return isPrivateIpv6(address);
  }
  return false;
}

async function ensurePublicFetchTarget(url: URL): Promise<void> {
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw toolError("web_fetch blocked a private host");
  }
  if (isPrivateAddress(hostname)) {
    throw toolError("web_fetch blocked a private host");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = (await lookup(hostname, { all: true })) as Array<{ address: string; family: number }>;
  } catch (error) {
    throw toolError(
      `web_fetch failed to resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const privateAddress = addresses.find((entry) => isPrivateAddress(entry.address));
  if (privateAddress) {
    throw toolError(`web_fetch blocked private address ${privateAddress.address}`);
  }
}

function formatDefuddleFailure(result: Awaited<ReturnType<typeof runProcess>>): string {
  if (result.timedOut) {
    return "defuddle timed out";
  }
  const stderr = result.stderr.trim();
  if (stderr) {
    return stderr;
  }
  return `defuddle exited with code ${result.exitCode}`;
}

export async function runWebFetchTool(context: ToolContext, input: WebFetchInput): Promise<ToolEnvelope> {
  const url = parseFetchUrl(input.url);
  if (context.config.web_fetch.block_private_hosts) {
    await ensurePublicFetchTarget(url);
  }

  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess(context.config.web_fetch.command, ["parse", url.toString(), "--md"], {
      cwd: context.cwd,
      abortSignal: context.abortSignal,
      maxOutputBytes: context.catastrophicOutputLimit,
      timeoutMs: Math.ceil(context.config.web_fetch.timeout * 1000),
    });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw toolError("Defuddle fetch failed: defuddle command not found");
    }
    throw toolError(`Defuddle fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.outputLimitExceeded) {
    throw toolError(`defuddle output exceeded catastrophic_output_limit (${context.catastrophicOutputLimit} bytes)`);
  }
  if (result.exitCode !== 0) {
    throw toolError(`Defuddle fetch failed: ${formatDefuddleFailure(result)}`);
  }
  const content = result.stdout.trim();
  if (!content) {
    throw toolError("Defuddle fetch failed: defuddle returned empty content");
  }

  const artifactDecision = await maybeArtifactForText(context, "web-fetch", content, "text/markdown");
  return {
    ok: true,
    summary: `Fetched ${url.toString()} with Defuddle.`,
    data: {
      url: url.toString(),
      mode: "defuddle",
      content: artifactDecision.partial ? artifactDecision.preview : content,
      truncated: artifactDecision.partial,
      artifact: artifactDecision.artifact,
    },
  };
}
