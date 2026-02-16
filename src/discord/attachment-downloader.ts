import { writeFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { extname } from "path";
import type { Collection, Attachment } from "discord.js";

export async function downloadAttachments(
  attachments: Collection<string, Attachment>,
): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (const attachment of attachments.values()) {
      const ext = extname(attachment.name) || ".bin";
      const tmpPath = `.tmp/${randomUUID()}${ext}`;
      const res = await fetch(attachment.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(tmpPath, buffer);
      paths.push(tmpPath);
    }
  } catch (err) {
    await cleanupFiles(paths);
    throw err;
  }
  return paths;
}

export async function cleanupFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    await unlink(p).catch((err) =>
      console.error(`Failed to delete ${p}:`, err),
    );
  }
}
