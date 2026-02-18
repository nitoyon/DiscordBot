import type { Config } from "../config.js";
import { extractTextFromAssistantMessage } from "./response-parser.js";
import { parseResponseText, type ParsedLine } from "./response-line-parser.js";
import { startClaudeQuery } from "./query.js";

const MAX_LOOP_COUNT = 5;

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

      if (msg.type !== "assistant") continue;
      if (this.sessionId !== msg.session_id) {
        this.sessionId = msg.session_id;
        this.onSessionChange?.(msg.session_id);
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