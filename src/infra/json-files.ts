import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";

/**
 * On Windows, fs.rename() may fail with EPERM/EACCES when the target file
 * is momentarily locked (antivirus scan, prior handle not yet released).
 * Retry with exponential backoff to work around transient locks.
 */
async function renameWithRetry(src: string, dest: string, maxRetries = 5): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (IS_WINDOWS && (code === "EPERM" || code === "EACCES") && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options?: { mode?: number; trailingNewline?: boolean; ensureDirMode?: number },
) {
  const text = JSON.stringify(value, null, 2);
  await writeTextAtomic(filePath, text, {
    mode: options?.mode,
    ensureDirMode: options?.ensureDirMode,
    appendTrailingNewline: options?.trailingNewline,
  });
}

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: { mode?: number; ensureDirMode?: number; appendTrailingNewline?: boolean },
) {
  const mode = options?.mode ?? 0o600;
  const payload =
    options?.appendTrailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  const mkdirOptions: { recursive: true; mode?: number } = { recursive: true };
  if (typeof options?.ensureDirMode === "number") {
    mkdirOptions.mode = options.ensureDirMode;
  }
  await fs.mkdir(path.dirname(filePath), mkdirOptions);
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, payload, "utf8");
    try {
      await fs.chmod(tmp, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
    await renameWithRetry(tmp, filePath);
    try {
      await fs.chmod(filePath, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function createAsyncLock() {
  let lock: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
}
