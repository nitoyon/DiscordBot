import { readFileSync } from "fs";
import { resolve } from "path";

export function buildMessagePrompt(params: {
  id: string;
  skill: string;
  content: string;
  channelId: string;
  channelName?: string;
  attachments?: string[];
  username?: string;
  userid?: string;
  displayname?: string;
  created?: string;
}): string {
  const attachmentsValue = params.attachments?.length
    ? ` ${params.attachments.join(" ")}`
    : "";
  const lines = [
    params.skill === "" ?
      `content: ${params.content}` :
      `/${params.skill} ${params.content}`,
    `id: ${params.id}`,
  ];
  if (params.username) lines.push(`username: ${params.username}`);
  if (params.userid) lines.push(`userid: ${params.userid}`);
  if (params.displayname) lines.push(`displayname: ${params.displayname}`);
  if (params.created) lines.push(`created: ${params.created}`);
  if (params.channelName) lines.push(`channelname: ${params.channelName}`);
  lines.push(
    `channel: ${params.channelId}`,
    `attachments:${attachmentsValue}`,
    `reactions:`,
  );
  return lines.join("\n");
}

export function buildReactionPrompt(params: {
  emoji: string;
  targetMessageId: string;
  channelId: string;
  channelName?: string;
}): string {
  const lines = [
    `[reaction added]`,
    `target_message_id: ${params.targetMessageId}`,
    `emoji: ${params.emoji}`,
    `channel: ${params.channelId}`,
  ];
  if (params.channelName) lines.push(`channelname: ${params.channelName}`);
  return lines.join("\n");
}

let cachedSystemPrompt: string | undefined;

export function loadSystemPrompt(): string {
  if (cachedSystemPrompt) return cachedSystemPrompt;

  const promptPath = resolve("docs", "PROMPT.md");
  const content = readFileSync(promptPath, "utf-8");
  cachedSystemPrompt = `<system-context>\n${content}\n</system-context>`;
  return cachedSystemPrompt;
}
