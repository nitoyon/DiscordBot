import type { Config } from "../config.js";
import { extractTextFromAssistantMessage } from "./response-parser.js";
import { parseResponseText, type ParsedLine } from "./response-line-parser.js";
import { startClaudeQuery } from "./query.js";

const MAX_LOOP_COUNT = 5;

function formatToolInput(toolName: string, input: unknown): string {
  console.log("tool", toolName);
  if (toolName === "Bash" && typeof input === "object" && input !== null) {
    const cmd = (input as { command?: string }).command ?? "";
    const truncated = cmd.length > 300 ? cmd.slice(0, 300) + "..." : cmd;
    return `\`${truncated}\``;
  }
  const str = JSON.stringify(input);
  return str.length > 300 ? str.slice(0, 300) + "..." : str;
}

/**
 * Handles parsed lines from Claude's response.
 * Return a string to feed back to Claude as a new message (for !discord history).
 * Return undefined to continue normally.
 */
export interface ClaudeSessionHandlers {
  handleLines(lines: ParsedLine[]): Promise<string | undefined>;
}

export class ClaudeSession {
  sessionId: string | undefined;
  onSessionChange?: (sessionId: string) => void;
  onLog?: (text: string) => Promise<void>;

  constructor(
    private config: Config,
    private workdir: string,
    private handlers: ClaudeSessionHandlers,
    sessionId?: string,
  ) {
    this.sessionId = sessionId;
  }

  async run(prompt: string): Promise<void> {
    let prompts = [prompt];

    for (let i = 0; i < MAX_LOOP_COUNT; i++) {
      const nextPrompts: string[] = [];
      for (const p of prompts) {
        const feedbacks = await this.handlePrompt(p);
        nextPrompts.push(...feedbacks);
      }
      prompts = nextPrompts;
      if (prompts.length === 0) return;
    }

    console.error(`[ClaudeSession] Max loop count (${MAX_LOOP_COUNT}) reached`);
  }

  private async handlePrompt(prompt: string): Promise<string[]> {
    const stream = startClaudeQuery(prompt, this.workdir, this.config, this.sessionId);
    const bashToolUseIds = new Set<string>();

    for await (const msg of stream) {
      if (msg.type === "result") {
        if (this.sessionId !== msg.session_id) {
          this.sessionId = msg.session_id;
          this.onSessionChange?.(msg.session_id);
        }
        if (msg.subtype !== "success") {
          console.error(`Claude query error (${msg.subtype})`);
        }
        continue;
      }

      // tool_result をログ出力
      if (msg.type === "user" && this.onLog) {
        const content = (msg.message as { content: unknown }).content;
        if (Array.isArray(content)) {
          for (const block of content as Array<{ type?: string; content?: unknown }>) {
            if (block.type === "tool_result") {
              const toolUseId = (block as { tool_use_id?: string }).tool_use_id ?? "";
              if (!bashToolUseIds.has(toolUseId)) continue;
              const output =
                typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content);
              const truncated =
                output.length > 1800 ? output.slice(0, 1800) + "\n...(省略)" : output;
              await this.onLog(`\`\`\`\n${truncated}\n\`\`\``);
            }
          }
        }
        continue;
      }

      if (msg.type !== "assistant") continue;
      if (this.sessionId !== msg.session_id) {
        this.sessionId = msg.session_id;
        this.onSessionChange?.(msg.session_id);
      }

      // tool_use をログ出力
      if (this.onLog) {
        const content = (msg.message as { content: unknown[] }).content;
        for (const block of content as Array<{ type?: string; name?: string; input?: unknown }>) {
          if (block.type === "tool_use" && block.name === "Bash") {
            const toolUseId = (block as { id?: string }).id ?? "";
            bashToolUseIds.add(toolUseId);
            const inputStr = formatToolInput(block.name ?? "", block.input);
            console.log(`**${block.name}**: ${inputStr}`);
            await this.onLog(`**${block.name}**: ${inputStr}`);
          }
        }
      }

      const text = extractTextFromAssistantMessage(msg);
      if (!text.trim()) continue;

      const lines = parseResponseText(text);
      const feedbackPrompt = await this.handlers.handleLines(lines);
      if (feedbackPrompt !== undefined) {
        return [feedbackPrompt];
      }
    }

    return [];
  }
}