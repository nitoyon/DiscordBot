import type { Message, TextChannel } from "discord.js";
import type { ParsedLine } from "../claude/response-line-parser.js";
import type { ClaudeSessionHandlers } from "../claude/session.js";
import type { Config } from "../config.js";
import {
  executeReaction,
  executeDelete,
  executeHistory,
  executeExec,
  executeSend,
  executeSendto,
} from "./command-executor.js";

interface PendingMessage {
  textLines: string[];
  mediaFiles: string[];
  reactions: string[];
}

function createPendingMessage(): PendingMessage {
  return { textLines: [], mediaFiles: [], reactions: [] };
}

/**
 * 溜まったテキスト/メディア/リアクションを Discord に送信する
 * @param channel 送信先チャンネル（null の場合は console.log のみ）
 * @param pending 送信するメッセージ
 */
async function flushPending(
  channel: TextChannel | null,
  pending: PendingMessage,
): Promise<void> {
  const text = pending.textLines.join("\n");
  if (!text.trim() && pending.mediaFiles.length === 0) return;

  console.log(`[flushPending] -> ${channel?.name ?? "null"}: "${text.slice(0, 80).replace(/\n/g, "\\n")}"`);

  // channel が null の場合は console.log のみ
  if (!channel) {
    if (text.trim()) {
      console.log(`[Discord output (no log channel)] ${text}`);
    }
    return;
  }

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

export interface DiscordHandlerOptions {
  /** チャンネル */
  channel: TextChannel;
  /** スキルモードかどうか */
  isSkillMode?: boolean;
  /** ログ出力用チャンネル（スキルモード時のテキスト出力先） */
  logChannel?: TextChannel;
  /** 設定 */
  config: Config;
  /** メッセージをキューに追加するコールバック */
  enqueue: (message: Message) => void;
}

/**
 * Create a ClaudeSessionHandlers implementation that outputs to Discord.
 * Buffers text/media/reactions and sends them as Discord messages.
 * Executes !discord commands against the given channel.
 * Returns history text for !discord history to feed back to ClaudeSession.
 *
 * If isSkillMode is true:
 *   - logChannel があれば logChannel に出力
 *   - logChannel がなければ console.log のみ（Discord には出力しない）
 * If isSkillMode is false:
 *   - channel に出力
 */
export function createDiscordHandler(
  options: DiscordHandlerOptions,
): ClaudeSessionHandlers {
  const { channel, isSkillMode, logChannel, config, enqueue } = options;
  const cmdCtx = { channel, allowedUserId: config.discord.user };
  // テキスト出力先:
  // - スキルモードでない場合は channel
  // - スキルモードの場合は logChannel があればそちら、なければ null（console.log のみ）
  const textOutputChannel = isSkillMode ? (logChannel ?? null) : channel;

  return {
    async handleLines(lines: ParsedLine[]): Promise<string | undefined> {
      let pending = createPendingMessage();

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

          case "discord_nop":
            break;

          case "discord_reaction":
            await flushPending(textOutputChannel, pending);
            pending = createPendingMessage();
            await executeReaction(cmdCtx, line.messageId, line.emoji, line.remove);
            break;

          case "discord_delete":
            await flushPending(textOutputChannel, pending);
            pending = createPendingMessage();
            await executeDelete(cmdCtx, line.messageId);
            break;

          case "discord_history": {
            await flushPending(textOutputChannel, pending);
            const historyText = await executeHistory(
              cmdCtx,
              line.count,
              line.channelId,
              line.offset,
            );
            return historyText;
          }

          case "discord_exec": {
            await flushPending(textOutputChannel, pending);
            pending = createPendingMessage();
            const execMessage = await executeExec(cmdCtx, line.messageId);
            if (!execMessage) {
              console.error(
                `[!discord exec] Failed to fetch message ${line.messageId}`,
              );
              break;
            }
            enqueue(execMessage);
            break;
          }

          case "discord_send":
            await flushPending(textOutputChannel, pending);
            pending = createPendingMessage();
            await executeSend(cmdCtx, line.message);
            break;

          case "discord_sendto":
            await flushPending(textOutputChannel, pending);
            pending = createPendingMessage();
            await executeSendto(cmdCtx, line.channel, line.message);
            break;
        }
      }

      await flushPending(textOutputChannel, pending);
      return undefined;
    },
  };
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
