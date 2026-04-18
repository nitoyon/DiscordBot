import { Message, MessageFlags, TextChannel } from "discord.js";

export interface CommandContext {
  channel: TextChannel;
  allowedUserId?: string;
  replyToMessageId?: string;
}

export async function executeReaction(
  ctx: CommandContext,
  messageId: string,
  emoji: string,
  remove: boolean,
): Promise<void> {
  try {
    const message = await ctx.channel.messages.fetch(messageId);
    if (remove) {
      const botId = ctx.channel.client.user!.id;
      await message.reactions.resolve(emoji)?.users.remove(botId);
    } else {
      await message.react(emoji);
    }
  } catch (err) {
    console.error(`[!discord reaction] Error:`, err);
  }
}

export async function executeDelete(
  ctx: CommandContext,
  messageId: string,
): Promise<void> {
  try {
    const message = await ctx.channel.messages.fetch(messageId);
    const botId = ctx.channel.client.user!.id;
    if (message.author.id !== botId) {
      console.error(
        `[!discord delete] Cannot delete message ${messageId}: not bot's own message`,
      );
      return;
    }
    await message.delete();
  } catch (err) {
    console.error(`[!discord delete] Error:`, err);
  }
}

export async function executeExec(
  ctx: CommandContext,
  messageId: string,
): Promise<Message | null> {
  try {
    return await ctx.channel.messages.fetch(messageId);
  } catch (err) {
    console.error(`[!discord exec] Error fetching message ${messageId}:`, err);
    return null;
  }
}

export async function executeSend(
  ctx: CommandContext,
  message: string,
): Promise<void> {
  try {
    await ctx.channel.send({ content: message, flags: MessageFlags.SuppressEmbeds });
  } catch (err) {
    console.error(`[!discord send] Error:`, err);
  }
}

export async function executeReply(
  ctx: CommandContext,
  message: string,
): Promise<void> {
  try {
    if (!ctx.replyToMessageId) {
      console.error(`[!discord reply] Error: replyToMessageId is not set in CommandContext`);
      return;
    }

    const targetMessage = await ctx.channel.messages.fetch(ctx.replyToMessageId);
    await targetMessage.reply({
      content: message,
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: { repliedUser: false }
    });
  } catch (err) {
    console.error(`[!discord reply] Error:`, err);
  }
}

export async function executeSendto(
  ctx: CommandContext,
  channelRef: string,
  message: string,
): Promise<void> {
  try {
    const client = ctx.channel.client;

    // チャンネルIDの場合は直接取得、チャンネル名の場合はギルド内で検索
    let targetChannel: TextChannel | null = null;

    // 数字のみならIDとして扱う
    if (/^\d+$/.test(channelRef)) {
      const fetched = await client.channels.fetch(channelRef);
      if (fetched instanceof TextChannel) {
        targetChannel = fetched;
      }
    } else {
      // チャンネル名で検索（現在のギルドから）
      const guild = ctx.channel.guild;
      const found = guild.channels.cache.find(
        (ch) => ch.name === channelRef && ch instanceof TextChannel
      );
      if (found instanceof TextChannel) {
        targetChannel = found;
      }
    }

    if (!targetChannel) {
      console.error(`[!discord sendto] Channel not found: ${channelRef}`);
      return;
    }

    await targetChannel.send({ content: message, flags: MessageFlags.SuppressEmbeds });
  } catch (err) {
    console.error(`[!discord sendto] Error:`, err);
  }
}

export interface HistoryMessage {
  id: string;
  author: string;
  displayName: string;
  isBot: boolean;
  content: string;
  timestamp: Date;
  attachments: string[];
  reactions: string[];
}

export interface HistoryResult {
  channelName: string;
  messages: HistoryMessage[];
  offset: number;
}

/**
 * 履歴を構造化データとして取得する (文字列化なし)
 * @returns Message[] (新しい順)
 */
export async function executeHistoryRaw(
  ctx: CommandContext,
  count: number,
  channelId: string | null,
  offset: number,
): Promise<Message[]> {
  try {
    const client = ctx.channel.client;
    let targetChannel: TextChannel;

    if (channelId) {
      const fetched = await client.channels.fetch(channelId);
      if (!(fetched instanceof TextChannel)) {
        console.error(`[!discord history] Channel <#${channelId}> is not a text channel`);
        return [];
      }
      targetChannel = fetched;
    } else {
      targetChannel = ctx.channel;
    }

    let beforeId: string | undefined;

    // Skip `offset` messages to find the anchor point
    if (offset > 0) {
      let skipped = 0;
      while (skipped < offset) {
        const batch = Math.min(offset - skipped, 100);
        const msgs = await targetChannel.messages.fetch({
          limit: batch,
          ...(beforeId ? { before: beforeId } : {}),
        });
        if (msgs.size === 0) break;
        beforeId = msgs.lastKey();
        skipped += msgs.size;
      }
    }

    // Fetch requested messages in batches of 100
    const allMessages: Message[] = [];
    let remaining = count;

    while (remaining > 0) {
      const msgs = await targetChannel.messages.fetch({
        limit: 100,
        ...(beforeId ? { before: beforeId } : {}),
      });
      if (msgs.size === 0) break;

      for (const msg of msgs.values()) {
        if (remaining <= 0) break;

        if (ctx.allowedUserId) {
          // 特定ユーザーのメッセージのみを含める
          if (msg.author.id !== ctx.allowedUserId) continue;
        } else {
          // allowAllUsers モード: bot を除く全ユーザーを含める
          if (msg.author.bot) continue;
        }

        allMessages.push(msg);
        remaining--;
      }
      beforeId = msgs.lastKey();
      if (msgs.size < 100) break; // これ以上メッセージがない
    }

    return allMessages;
  } catch (err) {
    console.error(`[!discord history] Error:`, err);
    return [];
  }
}

/**
 * 履歴を文字列として取得する (Claude 向け)
 */
export async function executeHistory(
  ctx: CommandContext,
  count: number,
  channelId: string | null,
  offset: number,
): Promise<string> {
  const messages = await executeHistoryRaw(ctx, count, channelId, offset);

  if (messages.length === 0) {
    return `--- history error: No messages found ---`;
  }

  const botId = ctx.channel.client.user!.id;
  const channelName = ctx.channel.name;

  const lines = messages.map((msg) => {
    const ts = msg.createdAt.toISOString();
    const attachmentInfo =
      msg.attachments.size > 0
        ? ` [attachments: ${Array.from(msg.attachments.values()).map(a => a.url).join(", ")}]`
        : "";
    const reactions = msg.reactions.cache.map((r) => r.emoji.name ?? r.emoji.toString());
    const reactionInfo =
      reactions.length > 0 ? ` [reactions: ${reactions.join("")}]` : "";
    const botTag = msg.author.id === botId ? " [BOT]" : "";
    return `[${ts}] ${msg.author.displayName} (${msg.author.username})${botTag} (${msg.id}): ${msg.content}${attachmentInfo}${reactionInfo}`;
  });

  return [
    `--- history of #${channelName} (${messages.length} messages, offset ${offset}) ---`,
    ...lines,
    `--- end history ---`,
  ].join("\n");
}
