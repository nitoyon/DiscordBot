import type { Message, TextChannel } from "discord.js";
import type { Config } from "../config.js";
import type { SessionManager } from "../session-manager.js";
import { buildMessagePrompt } from "../claude/prompt-builder.js";
import { startClaudeQuery } from "../claude/query.js";
import { streamToDiscord } from "./stream-handler.js";
import { downloadAttachments, cleanupFiles } from "./attachment-downloader.js";

export interface QueuedMessage {
  message: Message;
  channel: TextChannel;
  channelConfig: { name: string; skill: string; workdir: string };
}

export class ChannelQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Map<string, boolean>();
  private config: Config;
  private sessions: SessionManager;

  constructor(config: Config, sessions: SessionManager) {
    this.config = config;
    this.sessions = sessions;
  }

  enqueue(item: QueuedMessage): void {
    const channelId = item.message.channelId;

    if (!this.queues.has(channelId)) {
      this.queues.set(channelId, []);
    }
    this.queues.get(channelId)!.push(item);

    if (!this.processing.get(channelId)) {
      this.processLoop(channelId).catch((err) => {
        console.error(`[${channelId}] Fatal processLoop error:`, err);
        this.processing.set(channelId, false);
      });
    }
  }

  private async processLoop(channelId: string): Promise<void> {
    this.processing.set(channelId, true);

    while (true) {
      const queue = this.queues.get(channelId);
      if (!queue || queue.length === 0) {
        this.processing.set(channelId, false);
        return;
      }

      const item = queue.shift()!;
      try {
        await this.processMessage(item);
      } catch (error) {
        console.error(
          `[${item.channelConfig.name}] Processing error:`,
          error,
        );
        await item.channel
          .send("Error processing your request.")
          .catch(() => {});
      }
    }
  }

  private async processMessage(item: QueuedMessage): Promise<void> {
    const { message, channel, channelConfig } = item;

    const attachmentPaths = await downloadAttachments(message.attachments);
    try {
      const prompt = buildMessagePrompt({
        id: message.id,
        skill: channelConfig.skill,
        content: message.content,
        channelId: message.channelId,
        attachments: attachmentPaths,
      });

      const queryStream = startClaudeQuery(
        prompt,
        message.channelId,
        channelConfig.workdir,
        this.config,
        this.sessions,
      );

      const { sessionId } = await streamToDiscord(queryStream, channel);

      if (sessionId) {
        this.sessions.setSessionId(message.channelId, sessionId);
      }
    } finally {
      await cleanupFiles(attachmentPaths);
    }
  }
}
