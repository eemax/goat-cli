import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";

import type { ArtifactRef } from "./types.js";
import { atomicWriteFile, sha256Hex } from "./utils.js";

const EXTENSIONS: Record<string, string> = {
  "text/plain": ".txt",
  "application/json": ".json",
};

export class ArtifactStore {
  private counter = 0;
  private totalBytes = 0;

  public constructor(
    readonly _runRoot: string,
    private readonly artifactsDir: string,
  ) {}

  public stats(): { count: number; total_bytes: number } {
    return { count: this.counter, total_bytes: this.totalBytes };
  }

  public async write(prefix: string, content: string, contentType: string): Promise<ArtifactRef> {
    this.counter += 1;
    await mkdir(this.artifactsDir, { recursive: true });
    const extension = (EXTENSIONS[contentType] ?? extname(prefix)) || ".bin";
    const fileName = `${prefix}-${String(this.counter).padStart(3, "0")}${extension}`;
    const absolutePath = join(this.artifactsDir, fileName);
    await atomicWriteFile(absolutePath, content);
    this.totalBytes += Buffer.byteLength(content);
    return {
      path: `artifacts/${fileName}`,
      bytes: Buffer.byteLength(content),
      sha256: sha256Hex(content),
      content_type: contentType,
    };
  }
}

export function createPreview(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) {
    return text;
  }

  const head = text.slice(0, Math.floor(maxChars / 2));
  const tail = text.slice(text.length - Math.floor(maxChars / 2));
  return `${head}\n...\n${tail}`;
}
