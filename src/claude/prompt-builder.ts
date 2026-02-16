import { readFileSync } from "fs";
import { resolve } from "path";

export function buildMessagePrompt(params: {
  id: string;
  skill: string;
  content: string;
  channelId: string;
  attachments?: string[];
}): string {
  const attachmentsValue = params.attachments?.length
    ? ` ${params.attachments.join(" ")}`
    : "";
  return [
    `id: ${params.id}`,
    params.skill === "" ?
      `content: ${params.content}` :
      `content: /${params.skill} ${params.content}`,
    `channel: ${params.channelId}`,
    `attachments:${attachmentsValue}`,
    `reactions:`,
  ].join("\n");
}

let cachedSystemPrompt: string | undefined;

export function loadSystemPrompt(): string {
  if (cachedSystemPrompt) return cachedSystemPrompt;

  const promptPath = resolve("docs", "PROMPT.md");
  const content = readFileSync(promptPath, "utf-8");
  cachedSystemPrompt = `<system-context>\n${content}\n</system-context>`;
  return cachedSystemPrompt;
}
