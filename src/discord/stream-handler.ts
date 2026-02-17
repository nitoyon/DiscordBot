import type { Message, TextChannel } from "discord.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import type { SessionManager } from "../session-manager.js";
import { extractTextFromAssistantMessage } from "../claude/response-parser.js";
import { parseResponseText } from "../claude/response-line-parser.js";
import {
  executeReaction,
  executeDelete,
  executeHistory,
  executeExec,
} from "./command-executor.js";
import { startClaudeQuery } from "../claude/query.js";
import { buildMessagePrompt } from "../claude/prompt-builder.js";

const MAX_RECURSION_DEPTH = 5;

export interface StreamContext {
  channel: TextChannel;
  channelId: string;
  workdir: string;
  skill: string;
  config: Config;
  sessions: SessionManager;
}

export interface StreamResult {
  sessionId: string | undefined;
}

interface PendingMessage {
  textLines: string[];
  mediaFiles: string[];
  reactions: string[];
}

function createPendingMessage(): PendingMessage {
  return { textLines: [], mediaFiles: [], reactions: [] };
}

async function flushPending(
  channel: TextChannel,
  pending: PendingMessage,
): Promise<void> {
  const text = pending.textLines.join("\n");
  if (!text.trim() && pending.mediaFiles.length === 0) return;

  const chunks = splitMessage(text, 2000);
  let lastMessage: Message | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const content = chunks[i];
    if (i === 0 && pending.mediaFiles.length > 0) {
      lastMessage = await channel.send({
        content: content || undefined,
        files: pending.mediaFiles,
      });
    } else {
      lastMessage = await channel.send(content);
    }
  }

  // If we only had media with no text
  if (chunks.length === 0 && pending.mediaFiles.length > 0) {
    lastMessage = await channel.send({ files: pending.mediaFiles });
  }

  if (lastMessage && pending.reactions.length > 0) {
    for (const emoji of pending.reactions) {
      try {
        await lastMessage.react(emoji);
      } catch (err) {
        console.error(`[reactions] Failed to react with ${emoji}:`, err);
      }
    }
  }
}

/**
 * Consume an async generator of SDKMessages, parse Claude's response,
 * execute !discord commands, and stream text to Discord.
 *
 * When !discord history is encountered, results are fed back to Claude
 * as a new query (same session), creating a feedback loop.
 */
export async function streamToDiscord(
  messageStream: AsyncGenerator<SDKMessage, void>,
  ctx: StreamContext,
  depth = 0,
): Promise<StreamResult> {
  let sessionId: string | undefined;

  for await (const msg of messageStream) {
    if (msg.type === "result") {
      sessionId = msg.session_id;
      if (msg.subtype !== "success") {
        console.error(`Claude query error (${msg.subtype})`);
      }
      continue;
    }

    if (msg.type !== "assistant") continue;

    const text = extractTextFromAssistantMessage(msg);
    if (!text.trim()) continue;

    const lines = parseResponseText(text);
    let pending = createPendingMessage();
    const cmdCtx = { channel: ctx.channel };

    for (const line of lines) {
      switch (line.type) {
        case "text":
          pending.textLines.push(line.content);
          break;

        case "media":
          pending.mediaFiles.push(line.filePath);
          break;

        case "reactions":
          pending.reactions.push(...line.emojis);
          break;

        case "discord_reaction":
          await flushPending(ctx.channel, pending);
          pending = createPendingMessage();
          await executeReaction(
            cmdCtx,
            line.messageId,
            line.emoji,
            line.remove,
          );
          break;

        case "discord_delete":
          await flushPending(ctx.channel, pending);
          pending = createPendingMessage();
          await executeDelete(cmdCtx, line.messageId);
          break;

        case "discord_history": {
          await flushPending(ctx.channel, pending);
          pending = createPendingMessage();

          if (depth >= MAX_RECURSION_DEPTH) {
            console.error(
              `[!discord history] Max recursion depth (${MAX_RECURSION_DEPTH}) reached`,
            );
            break;
          }

          const historyText = await executeHistory(
            cmdCtx,
            line.count,
            line.channelId,
            line.offset,
          );

          // Save current session so the next query resumes it
          if (sessionId) {
            ctx.sessions.setSessionId(ctx.channelId, sessionId);
          }

          const feedbackStream = startClaudeQuery(
            historyText,
            ctx.channelId,
            ctx.workdir,
            ctx.config,
            ctx.sessions,
          );

          const feedbackResult = await streamToDiscord(
            feedbackStream,
            ctx,
            depth + 1,
          );
          if (feedbackResult.sessionId) {
            sessionId = feedbackResult.sessionId;
          }

          return { sessionId };
        }

        case "discord_exec": {
          await flushPending(ctx.channel, pending);
          pending = createPendingMessage();

          if (depth >= MAX_RECURSION_DEPTH) {
            console.error(
              `[!discord exec] Max recursion depth (${MAX_RECURSION_DEPTH}) reached`,
            );
            break;
          }

          const execResult = await executeExec(cmdCtx, line.messageId);
          if (!execResult) {
            console.error(`[!discord exec] Failed to fetch message ${line.messageId}`);
            break;
          }

          const execPrompt = buildMessagePrompt({
            id: execResult.id,
            skill: ctx.skill,
            content: execResult.content,
            channelId: ctx.channelId,
            attachments: execResult.attachments,
          });

          // Save current session so the next query resumes it
          if (sessionId) {
            ctx.sessions.setSessionId(ctx.channelId, sessionId);
          }

          const execStream = startClaudeQuery(
            execPrompt,
            ctx.channelId,
            ctx.workdir,
            ctx.config,
            ctx.sessions,
            { forceNewSession: ctx.skill !== "" },
          );

          const execStreamResult = await streamToDiscord(
            execStream,
            ctx,
            depth + 1,
          );
          if (execStreamResult.sessionId) {
            sessionId = execStreamResult.sessionId;
          }

          break;
        }
      }
    }

    await flushPending(ctx.channel, pending);
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
