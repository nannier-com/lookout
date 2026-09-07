/** Durable, collision-safe replacement of one file. */
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertStateLocksHealthy } from "./lock.js";

export async function atomicWriteFile(
  path: string,
  body: string | Uint8Array,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = null;
    assertStateLocksHealthy();
    await rename(temp, path);

    // Persist the directory entry where the platform permits directory fsync.
    try {
      const directory = await open(dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Windows and some filesystems reject directory handles or directory sync.
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
