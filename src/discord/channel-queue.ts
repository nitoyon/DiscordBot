import { type Client, type Message, TextChannel } from "discord.js";
import type { Config } from "../config.js";
import type { SessionManager } from "../session-manager.js";
import { buildMessagePrompt, buildReactionPrompt } from "../claude/prompt-builder.js";
import { ClaudeSession } from "../claude/session.js";
import { createDiscordHandler } from "./stream-handler.js";
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
  private logChannel: TextChannel | undefined;

  constructor(config: Config, sessions: SessionManager) {
    this.config = config;
    this.sessions = sessions;
  }

  /**
   * ログチャンネルをセットする
   */
  setLogChannel(channel: TextChannel): void {
    this.logChannel = channel;
  }

  enqueueMessage(message: Message): void {
    if (message.author.bot) return;
    if (message.author.id !== this.config.discord.user.toString()) return;

    if (!(message.channel instanceof TextChannel)) return;
    const channel = message.channel;

    const channelConfig = this.config.channels.find(
      (ch) => ch.name === channel.name,
    );
    if (!channelConfig) return;

    console.log(
      `[Discord] #${channel.name} ${message.author.username}: ${message.content}`,
    );

    this.enqueueItem({ message, channel, channelConfig, type: "message" });
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
      this.processing.set(channelId, true);
      setImmediate(() => this.processNext(channelId));
    }
  }

  private processNext(channelId: string): void {
    const queue = this.queues.get(channelId);
    if (!queue || queue.length === 0) {
      this.processing.set(channelId, false);
      return;
    }

    const item = queue.shift()!;
    this.processItem(item)
      .catch(async (error) => {
        console.error(
          `[${item.channelConfig.name}] Processing error:`,
          error,
        );
        await item.channel
          .send("Error processing your request.")
          .catch(() => {});
      })
      .finally(() => {
        setImmediate(() => this.processNext(channelId));
      });
  }

  private async processItem(item: QueuedItem): Promise<void> {
    if (item.type === "reaction") {
      await this.processReaction(item);
    } else {
      await this.processMessage(item);
    }
  }

  private makeLogCallback(): ((text: string) => Promise<void>) | undefined {
    if (!this.logChannel) return undefined;
    const logChannel = this.logChannel;
    return (text: string) => logChannel.send(text).then(() => undefined);
  }

  private async processReaction(item: QueuedReaction): Promise<void> {
    const { channel, channelConfig } = item;

    const prompt = buildReactionPrompt({
      emoji: item.emoji,
      targetMessageId: item.targetMessageId,
      channelId: item.channelId,
    });

    const session = new ClaudeSession(
      this.config,
      channelConfig.workdir,
      createDiscordHandler({
        channel,
        config: this.config,
        enqueue: (msg) => this.enqueueItem({ message: msg, channel, channelConfig, type: "message" }),
      }),
      this.sessions.getSessionId(item.channelId),
    );
    session.onSessionChange = (id) => this.sessions.setSessionId(item.channelId, id);

    await session.run(prompt);
  }

  private async processMessage(item: QueuedTextMessage): Promise<void> {
    const { message, channel, channelConfig } = item;
    const isSkillMode = channelConfig.skill !== "";

    // スキルモード時はログチャンネルにスキル実行開始を通知
    if (isSkillMode && this.logChannel) {
      const guildId = channel.guild.id;
      const messageUrl = `https://discord.com/channels/${guildId}/${channel.id}/${message.id}`;
      await this.logChannel.send(`${messageUrl} に対してスキル \`/${channelConfig.skill}\` を実行...`);
    }

    const attachmentPaths = await downloadAttachments(message.attachments, channelConfig.workdir);
    try {
      const prompt = buildMessagePrompt({
        id: message.id,
        skill: channelConfig.skill,
        content: message.content,
        channelId: message.channelId,
        attachments: attachmentPaths,
      });

      const session = new ClaudeSession(
        this.config,
        channelConfig.workdir,
        createDiscordHandler({
          channel,
          isSkillMode,
          logChannel: this.logChannel,
          config: this.config,
          enqueue: (msg) => this.enqueueItem({ message: msg, channel, channelConfig, type: "message" }),
        }),
        isSkillMode ? undefined : this.sessions.getSessionId(message.channelId),
      );
      if (!isSkillMode) {
        session.onSessionChange = (id) => this.sessions.setSessionId(message.channelId, id);
      }
      session.onLog = this.makeLogCallback();

      await session.run(prompt);
    } finally {
      await cleanupFiles(attachmentPaths);
    }
  }

  /**
   * Run init skill for all channels with skill configured.
   * Called on bot startup to process messages that were posted while bot was offline.
   */
  async runInit(client: Client): Promise<void> {
    // ログチャンネルを取得してセット
    if (this.config.discord.logChannel) {
      const logCh = await client.channels.fetch(this.config.discord.logChannel);
      if (logCh instanceof TextChannel) {
        this.setLogChannel(logCh);
        console.log(`[Init] Log channel set to #${logCh.name}`);
      } else {
        console.warn(`[Init] Log channel ${this.config.discord.logChannel} is not a text channel`);
      }
    }

    // Filter channels with skill configured
    const skillChannels = this.config.channels.filter((ch) => ch.skill !== "");
    if (skillChannels.length === 0) {
      console.log("[Init] No channels with skill configured, skipping init");
      return;
    }

    console.log(`[Init] Running init for ${skillChannels.length} channel(s)`);

    // This project's workdir (where init skill is located)
    const initWorkdir = process.cwd();

    for (const channelConfig of skillChannels) {
      // Find the channel by name
      const channel = client.channels.cache.find(
        (ch) => ch instanceof TextChannel && ch.name === channelConfig.name,
      ) as TextChannel | undefined;

      if (!channel) {
        console.log(`[Init] Channel "${channelConfig.name}" not found, skipping`);
        continue;
      }

      console.log(`[Init] Running init for #${channelConfig.name} (${channel.id})`);

      const prompt = buildMessagePrompt({
        id: "init",
        skill: "init",
        content: `${channelConfig.name} <#${channel.id}>`,
        channelId: channel.id,
        attachments: [],
      });

      const session = new ClaudeSession(
        this.config,
        initWorkdir,
        createDiscordHandler({
          channel,
          isSkillMode: true,
          logChannel: this.logChannel,
          config: this.config,
          enqueue: (msg) => this.enqueueItem({ message: msg, channel, channelConfig, type: "message" }),
        }),
      );
      session.onLog = this.makeLogCallback();

      try {
        await session.run(prompt);
        console.log(`[Init] Completed init for #${channelConfig.name}`);
      } catch (error) {
        console.error(`[Init] Error running init for #${channelConfig.name}:`, error);
      }
    }

    console.log("[Init] Init completed for all channels");
  }
}
