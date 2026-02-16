import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

interface TextBlock {
  type: "text";
  text: string;
}

/**
 * Extract text content from a stream of SDK messages.
 * Line-level parsing (media:/reactions:/!discord) is in response-line-parser.ts.
 */
export function extractTextFromMessages(messages: SDKMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.type === "assistant") {
      const content = (msg.message as { content: unknown[] }).content;
      for (const block of content) {
        if ((block as TextBlock).type === "text") {
          parts.push((block as TextBlock).text);
        }
      }
    }
  }

  return parts.join("\n");
}

/**
 * Extract text content from a single assistant message.
 */
export function extractTextFromAssistantMessage(msg: SDKMessage): string {
  if (msg.type !== "assistant") return "";
  const content = (msg.message as { content: unknown[] }).content;
  const parts: string[] = [];
  for (const block of content) {
    if ((block as TextBlock).type === "text") {
      parts.push((block as TextBlock).text);
    }
  }
  return parts.join("\n");
}

/**
 * Extract session_id from SDK result messages.
 */
export function extractSessionId(messages: SDKMessage[]): string | undefined {
  for (const msg of messages) {
    if (msg.type === "result") {
      return msg.session_id;
    }
  }
  return undefined;
}
