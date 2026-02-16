import { writeFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { extname, join } from "path";
import type { Collection, Attachment } from "discord.js";

export async function downloadAttachments(
  attachments: Collection<string, Attachment>,
  workdir: string,
): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (const attachment of attachments.values()) {
      const ext = extname(attachment.name) || ".bin";
      const tmpPath = join(workdir, ".tmp", `${randomUUID()}${ext}`);
      const res = await fetch(attachment.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(tmpPath, buffer);
      console.log(`Downloaded attachment ${attachment.url} to ${tmpPath}`);
      paths.push(tmpPath);
    }
  } catch (err) {
    await cleanupFiles(paths);
    throw err;
  }
  return paths;
}

export async function cleanupFiles(paths: string[]): Promise<void> {
  console.log("Cleaning up files:", paths);
  for (const p of paths) {
    await unlink(p).catch((err) =>
      console.error(`Failed to delete ${p}:`, err),
    );
  }
}
