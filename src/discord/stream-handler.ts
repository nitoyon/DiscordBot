import { MessageFlags } from "discord.js";
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
  executeReply,
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
 * @returns 送信したメッセージ
 */
async function flushPending(
  channel: TextChannel | null,
  pending: PendingMessage,
): Promise<Message[]> {
  const text = pending.textLines.join("\n");
  if (!text.trim() && pending.mediaFiles.length === 0) return [];

  console.log(`[flushPending] -> ${channel?.name ?? "null"}: "${text.slice(0, 80).replace(/\n/g, "\\n")}"`);

  // channel が null の場合は console.log のみ
  if (!channel) {
    if (text.trim()) {
      console.log(`[Discord output (no log channel)] ${text}`);
    }
    return [];
  }

  const chunks = splitMessage(text, 2000);
  const sent: Message[] = [];
  let lastMessage: Message | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const content = chunks[i];
    if (i === 0 && pending.mediaFiles.length > 0) {
      lastMessage = await channel.send({
        content: content || undefined,
        files: pending.mediaFiles,
        flags: MessageFlags.SuppressEmbeds,
      });
    } else {
      lastMessage = await channel.send({
        content,
        flags: MessageFlags.SuppressEmbeds,
      });
    }
    sent.push(lastMessage);
  }

  if (chunks.length === 0 && pending.mediaFiles.length > 0) {
    lastMessage = await channel.send({ files: pending.mediaFiles });
    sent.push(lastMessage);
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
  return sent;
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
  /** 全ユーザーのメッセージを history 対象にするか */
  allowAllUsers?: boolean;
  /** リプライ対象のメッセージID */
  replyToMessageId?: string;
  /** Bot がメッセージを送信したときのコールバック（メッセージとセッションの対応表の記録用） */
  onMessageSent?: (message: Message) => void;
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
  const { channel, isSkillMode, logChannel, config, enqueue, allowAllUsers, replyToMessageId, onMessageSent } = options;
  const cmdCtx = {
    channel,
    allowedUserId: allowAllUsers ? undefined : config.discord.user,
    replyToMessageId
  };
  // テキスト出力先:
  // - スキルモードでない場合は channel
  // - スキルモードの場合は logChannel があればそちら、なければ null（console.log のみ）
  const textOutputChannel = isSkillMode ? (logChannel ?? null) : channel;

  const notifySent = (messages: Array<Message | undefined>): void => {
    if (!onMessageSent) return;
    for (const msg of messages) {
      if (msg) onMessageSent(msg);
    }
  };
  const flush = async (pending: PendingMessage): Promise<void> => {
    notifySent(await flushPending(textOutputChannel, pending));
  };

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
            await flush(pending);
            pending = createPendingMessage();
            await executeReaction(cmdCtx, line.messageId, line.emoji, line.remove);
            break;

          case "discord_delete":
            await flush(pending);
            pending = createPendingMessage();
            await executeDelete(cmdCtx, line.messageId);
            break;

          case "discord_history": {
            await flush(pending);
            const historyText = await executeHistory(
              cmdCtx,
              line.count,
              line.channelId,
              line.offset,
            );
            return historyText;
          }

          case "discord_exec": {
            await flush(pending);
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
            await flush(pending);
            pending = createPendingMessage();
            notifySent([await executeSend(cmdCtx, line.message)]);
            break;

          case "discord_reply":
            await flush(pending);
            pending = createPendingMessage();
            notifySent([await executeReply(cmdCtx, line.message)]);
            break;

          case "discord_sendto":
            await flush(pending);
            pending = createPendingMessage();
            notifySent([await executeSendto(cmdCtx, line.channel, line.message)]);
            break;
        }
      }

      await flush(pending);
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
