import type { Writable } from "node:stream";

import { isGoatError } from "./errors.js";

export function formatError(error: unknown): string {
  if (isGoatError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function writeText(stream: Writable, text: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    stream.write(text, (error) => {
      if (error) {
        rejectWrite(error);
        return;
      }
      resolveWrite();
    });
  });
}
