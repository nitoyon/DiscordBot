import type { Config } from "../config.js";
import { extractTextFromAssistantMessage } from "./response-parser.js";
import { parseResponseText, type ParsedLine } from "./response-line-parser.js";
import { startClaudeQuery } from "./query.js";

const MAX_RECURSION_DEPTH = 5;

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

  constructor(
    private config: Config,
    private workdir: string,
    private handlers: ClaudeSessionHandlers,
    sessionId?: string,
  ) {
    this.sessionId = sessionId;
  }

  async run(prompt: string, depth = 0): Promise<void> {
    const stream = startClaudeQuery(prompt, this.workdir, this.config, this.sessionId);

    for await (const msg of stream) {
      if (msg.type === "result") {
        if (msg.session_id) this.sessionId = msg.session_id;
        if (msg.subtype !== "success") {
          console.error(`Claude query error (${msg.subtype})`);
        }
        continue;
      }

      if (msg.type !== "assistant") continue;
      if (msg.session_id) this.sessionId = msg.session_id;

      const text = extractTextFromAssistantMessage(msg);
      if (!text.trim()) continue;

      const lines = parseResponseText(text);
      const feedbackPrompt = await this.handlers.handleLines(lines);
      if (feedbackPrompt !== undefined) {
        if (depth >= MAX_RECURSION_DEPTH) {
          console.error(
            `[ClaudeSession] Max recursion depth (${MAX_RECURSION_DEPTH}) reached`,
          );
          return;
        }
        await this.run(feedbackPrompt, depth + 1);
        return;
      }
    }
  }
}
