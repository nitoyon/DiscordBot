import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import type { SessionManager } from "../session-manager.js";
import { loadSystemPrompt } from "./prompt-builder.js";

export function startClaudeQuery(
  prompt: string,
  channelId: string,
  cwd: string,
  config: Config,
  sessions: SessionManager,
): Query {
  const existingSessionId = sessions.getSessionId(channelId);
  const isNewSession = !existingSessionId;

  console.log("[Claude] querry: ", query);
  console.log("[Claude] session: ",
    isNewSession ? "NEW" : existingSessionId);

  return query({
    prompt,
    options: {
      cwd,
      model: config.claude.model,
      systemPrompt: isNewSession ? loadSystemPrompt() : undefined,
      resume: existingSessionId ?? undefined,
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });
}
