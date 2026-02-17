import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { loadSystemPrompt } from "./prompt-builder.js";

export function startClaudeQuery(
  prompt: string,
  cwd: string,
  config: Config,
  sessionId: string | undefined,
): Query {
  const isNewSession = !sessionId;

  console.log("[Claude] querry:", prompt);
  console.log("[Claude] session:",
    isNewSession ? "NEW" : sessionId);

  return query({
    prompt,
    options: {
      cwd,
      model: config.claude.model,
      systemPrompt: isNewSession ? loadSystemPrompt() : undefined,
      resume: sessionId,
      maxTurns: 100,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project"],
    },
  });
}