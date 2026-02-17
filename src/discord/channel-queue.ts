import type { Message, TextChannel } from "discord.js";
import type { Config } from "../config.js";
import type { SessionManager } from "../session-manager.js";
import { buildMessagePrompt, buildReactionPrompt } from "../claude/prompt-builder.js";
import { startClaudeQuery } from "../claude/query.js";
import { streamToDiscord } from "./stream-handler.js";
import { downloadAttachments, cleanupFiles } from "./attachment-downloader.js";

interface ChannelConfig { name: string; skill: string; workdir: string }

export interface QueuedTextMessage {
  type: "message";
  message: Message;
  channel: TextChannel;
  channelConfig: ChannelConfig;
}

export interface QueuedReaction {
  type: "reaction";
  emoji: string;
  targetMessageId: string;
  channelId: string;
  channel: TextChannel;
  channelConfig: ChannelConfig;
}

export type QueuedItem = QueuedTextMessage | QueuedReaction;

export class ChannelQueue {
  private queues = new Map<string, QueuedItem[]>();
  private processing = new Map<string, boolean>();
  private config: Config;
  private sessions: SessionManager;

  constructor(config: Config, sessions: SessionManager) {
    this.config = config;
    this.sessions = sessions;
  }

  enqueue(item: Omit<QueuedTextMessage, "type">): void {
    this.enqueueItem({ ...item, type: "message" });
  }

  enqueueReaction(item: Omit<QueuedReaction, "type">): void {
    this.enqueueItem({ ...item, type: "reaction" });
  }

  private enqueueItem(item: QueuedItem): void {
    const channelId = item.type === "message" ? item.message.channelId : item.channelId;

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
        await this.processItem(item);
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

  private async processItem(item: QueuedItem): Promise<void> {
    if (item.type === "reaction") {
      await this.processReaction(item);
    } else {
      await this.processMessage(item);
    }
  }

  private async processReaction(item: QueuedReaction): Promise<void> {
    const { channel, channelConfig } = item;

    const prompt = buildReactionPrompt({
      emoji: item.emoji,
      targetMessageId: item.targetMessageId,
      channelId: item.channelId,
    });

    const queryStream = startClaudeQuery(
      prompt,
      item.channelId,
      channelConfig.workdir,
      this.config,
      this.sessions,
    );

    const { sessionId } = await streamToDiscord(queryStream, {
      channel,
      channelId: item.channelId,
      workdir: channelConfig.workdir,
      skill: channelConfig.skill,
      config: this.config,
      sessions: this.sessions,
    });

    if (sessionId) {
      this.sessions.setSessionId(item.channelId, sessionId);
    }
  }

  private async processMessage(item: QueuedTextMessage): Promise<void> {
    const { message, channel, channelConfig } = item;

    const attachmentPaths = await downloadAttachments(message.attachments, channelConfig.workdir);
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
        { forceNewSession: channelConfig.skill !== "" },
      );

      const { sessionId } = await streamToDiscord(queryStream, {
        channel,
        channelId: message.channelId,
        workdir: channelConfig.workdir,
        skill: channelConfig.skill,
        config: this.config,
        sessions: this.sessions,
      });

      if (sessionId) {
        this.sessions.setSessionId(message.channelId, sessionId);
      }
    } finally {
      await cleanupFiles(attachmentPaths);
    }
  }
}