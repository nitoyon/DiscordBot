import type { TextChannel } from "discord.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { extractTextFromAssistantMessage } from "../claude/response-parser.js";

interface StreamResult {
  sessionId: string | undefined;
}

/**
 * Consume an async generator of SDKMessages and stream assistant
 * messages to Discord as they arrive.
 */
export async function streamToDiscord(
  messageStream: AsyncGenerator<SDKMessage, void>,
  channel: TextChannel,
): Promise<StreamResult> {
  let sessionId: string | undefined;

  for await (const msg of messageStream) {
    if (msg.type === "assistant") {
      const text = extractTextFromAssistantMessage(msg);
      if (text.trim()) {
        const chunks = splitMessage(text, 2000);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
    }

    if (msg.type === "result") {
      sessionId = msg.session_id;
      if (msg.subtype !== "success") {
        console.error(`Claude query error (${msg.subtype})`);
      }
    }
  }

  return { sessionId };
}

export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    const splitIndex = remaining.lastIndexOf("\n", maxLength);
    const idx = splitIndex > 0 ? splitIndex : maxLength;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).replace(/^\n/, "");
  }
  return chunks;
}
