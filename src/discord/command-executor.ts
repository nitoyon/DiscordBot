import { TextChannel } from "discord.js";

export interface CommandContext {
  channel: TextChannel;
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

export interface ExecResult {
  id: string;
  content: string;
  attachments: string[];
}

export async function executeExec(
  ctx: CommandContext,
  messageId: string,
): Promise<ExecResult | null> {
  try {
    const message = await ctx.channel.messages.fetch(messageId);
    return {
      id: message.id,
      content: message.content,
      attachments: message.attachments.map((a) => a.url),
    };
  } catch (err) {
    console.error(`[!discord exec] Error fetching message ${messageId}:`, err);
    return null;
  }
}

export async function executeHistory(
  ctx: CommandContext,
  count: number,
  channelId: string | null,
  offset: number,
): Promise<string> {
  try {
    const client = ctx.channel.client;
    let targetChannel: TextChannel;

    if (channelId) {
      const fetched = await client.channels.fetch(channelId);
      if (!(fetched instanceof TextChannel)) {
        return `--- history error: Channel <#${channelId}> is not a text channel ---`;
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

    // Fetch requested messages in batches of 30
    const allMessages: { id: string; author: string; content: string; timestamp: Date; attachments: string[] }[] = [];
    let remaining = count;

    while (remaining > 0) {
      const batch = Math.min(remaining, 30);
      const msgs = await targetChannel.messages.fetch({
        limit: batch,
        ...(beforeId ? { before: beforeId } : {}),
      });
      if (msgs.size === 0) break;

      for (const msg of msgs.values()) {
        allMessages.push({
          id: msg.id,
          author: msg.author.username,
          content: msg.content,
          timestamp: msg.createdAt,
          attachments: msg.attachments.map((a) => a.url),
        });
      }
      beforeId = msgs.lastKey();
      remaining -= msgs.size;
    }

    const channelName = targetChannel.name;
    const lines = allMessages.map((m) => {
      const ts = m.timestamp.toISOString();
      const attachmentInfo =
        m.attachments.length > 0
          ? ` [attachments: ${m.attachments.join(", ")}]`
          : "";
      return `[${ts}] ${m.author} (${m.id}): ${m.content}${attachmentInfo}`;
    });

    return [
      `--- history of #${channelName} (${allMessages.length} messages, offset ${offset}) ---`,
      ...lines,
      `--- end history ---`,
    ].join("\n");
  } catch (err) {
    console.error(`[!discord history] Error:`, err);
    return `--- history error: ${err instanceof Error ? err.message : String(err)} ---`;
  }
}
