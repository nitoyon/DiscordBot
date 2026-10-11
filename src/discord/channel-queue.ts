import { type Client, type Message, TextChannel } from "discord.js";
import type { Config } from "../config.js";
import type { SessionManager } from "../session-manager.js";
import type { CronScheduler } from "../cron-scheduler.js";
import { buildMessagePrompt, buildReactionPrompt } from "../claude/prompt-builder.js";
import { ClaudeSession, SessionNotFoundError } from "../claude/session.js";
import { ScriptSession } from "../claude/script-session.js";
import { createDiscordHandler } from "./stream-handler.js";
import { downloadAttachments, cleanupFiles } from "./attachment-downloader.js";
import { processUnhandledMessages } from "../init-processor.js";
import { executeHistoryRaw } from "./command-executor.js";
import type { LookupResult, MessageSessionStore } from "../message-session-store.js";

export interface ChannelConfig {
  name: string;
  skill: string;
  script?: string;
  workdir: string;
  allowAllUsers?: boolean;
}

/**
 * スキル実行と exec 処理を順番に実行するためのタスクキュー。
 * /init スキルはデッドロック防止のため除外する。
 */
class SkillTaskQueue {
  private _running = false;
  private _queue: Array<() => Promise<void>> = [];

  run(task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._queue.push(async () => {
        try {
          await task();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      if (!this._running) {
        this._processNext();
      }
    });
  }

  private _processNext(): void {
    if (this._queue.length === 0) {
      this._running = false;
      return;
    }
    this._running = true;
    this._queue.shift()!().finally(() => this._processNext());
  }
}

export interface QueuedTextMessage {
  type: "message";
  message: Message;
  /** 処理対象のチャンネル（logChannel 上のリプライでも、元のスキルチャンネル） */
  channel: TextChannel;
  channelConfig: ChannelConfig;
  /** 対応表にあるメッセージへのリプライのとき、再開するセッション */
  sessionEntry?: LookupResult;
  /** リプライ先メッセージ（セッションを再開できず新規実行するときの文脈） */
  replyTo?: { id: string; content?: string };
}

export interface QueuedReaction {
  type: "reaction";
  emoji: string;
  targetMessageId: string;
  channelId: string;
  channel: TextChannel;
  channelConfig: ChannelConfig;
  /** 対応表にあるメッセージへのリアクションのとき、再開するセッション */
  sessionEntry?: LookupResult;
}

export type QueuedItem = QueuedTextMessage | QueuedReaction;

/** 対応表から引いた、セッション再開の対象 */
export interface SessionTarget {
  entry: LookupResult;
  channel: TextChannel;
  channelConfig: ChannelConfig;
}

export class ChannelQueue {
  private queues = new Map<string, QueuedItem[]>();
  private processing = new Map<string, boolean>();
  private config: Config;
  private sessions: SessionManager;
  private messageSessions: MessageSessionStore;
  private logChannel: TextChannel | undefined;
  private skillQueue = new SkillTaskQueue();

  constructor(config: Config, sessions: SessionManager, messageSessions: MessageSessionStore) {
    this.config = config;
    this.sessions = sessions;
    this.messageSessions = messageSessions;
  }

  /**
   * メッセージ ID から、再開すべきスキルセッションを引く。
   * 対応表にない、または元チャンネルが見つからない／設定から消えた場合は undefined。
   */
  resolveSessionTarget(messageId: string, client: Client): SessionTarget | undefined {
    const entry = this.messageSessions.lookup(messageId);
    if (!entry) return undefined;

    const channel = client.channels.cache.get(entry.channelId);
    if (!(channel instanceof TextChannel)) return undefined;

    const channelConfig = this.config.channels.find((ch) => ch.name === channel.name);
    if (!channelConfig) return undefined;

    return { entry, channel, channelConfig };
  }

  /**
   * ログチャンネルをセットする
   */
  setLogChannel(channel: TextChannel): void {
    this.logChannel = channel;
  }

  enqueueMessage(message: Message): void {
    if (message.author.bot) return;

    if (!(message.channel instanceof TextChannel)) return;
    const channel = message.channel;

    // 対応表にあるメッセージへのリプライは、そのセッションを再開する（logChannel 上でも可）
    const replyToId = message.reference?.messageId;
    const target = replyToId ? this.resolveSessionTarget(replyToId, message.client) : undefined;
    if (replyToId && target) {
      const allowAll = target.channelConfig.allowAllUsers && channel.id === target.channel.id;
      if (!allowAll && message.author.id !== this.config.discord.user.toString()) return;

      console.log(
        `[Discord] #${channel.name} ${message.author.username} replied to ${replyToId} (session ${target.entry.sessionId}): ${message.content}`,
      );
      this.enqueueItem({
        type: "message",
        message,
        channel: target.channel,
        channelConfig: target.channelConfig,
        sessionEntry: target.entry,
        replyTo: { id: replyToId },
      });
      return;
    }

    const channelConfig = this.config.channels.find(
      (ch) => ch.name === channel.name,
    );
    if (!channelConfig) return;

    if (!channelConfig.allowAllUsers) {
      if (message.author.id !== this.config.discord.user.toString()) return;
    }

    console.log(
      `[Discord] #${channel.name} ${message.author.username}: ${message.content}`,
    );

    this.enqueueItem({ message, channel, channelConfig, type: "message" });
  }

  enqueueReaction(item: Omit<QueuedReaction, "type">): void {
    this.enqueueItem({ ...item, type: "reaction" });
  }

  private enqueueItem(item: QueuedItem): void {
    // logChannel 上のリプライも、元チャンネルのキューで直列化する
    const channelId = item.channel.id;

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
    const { channel, channelConfig, sessionEntry } = item;

    const prompt = buildReactionPrompt({
      emoji: item.emoji,
      targetMessageId: item.targetMessageId,
      channelId: item.channelId,
      channelName: channel.name,
    });

    // 対応表にあるメッセージへのリアクション: そのセッションを再開する。
    // 期限切れや再開失敗のときは通知だけ出して終える（リアクションだけでは新規実行する内容がない）
    if (sessionEntry) {
      if (sessionEntry.expired) {
        await this.notifySessionUnavailable(sessionEntry, item.targetMessageId, "expired");
        return;
      }
      const resumed = await this.continueSession({
        entry: sessionEntry,
        channel,
        channelConfig,
        prompt,
        triggerMessageIds: [],
      });
      if (!resumed) {
        await this.notifySessionUnavailable(sessionEntry, item.targetMessageId, "not_found");
      }
      return;
    }

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

  /**
   * 対応表にあるメッセージへのリプライ: そのセッションを再開する。
   * 期限切れや再開失敗のときは通知したうえで、リプライ先の本文を添えて新規スキル実行する。
   */
  private async processSessionReply(
    item: QueuedTextMessage & { sessionEntry: LookupResult; replyTo: { id: string } },
  ): Promise<void> {
    const { message, channel, channelConfig, sessionEntry, replyTo } = item;

    if (!sessionEntry.expired) {
      const attachmentPaths = await downloadAttachments(message.attachments, channelConfig.workdir);
      let resumed: boolean;
      try {
        const prompt = buildMessagePrompt({
          id: message.id,
          skill: "",
          content: message.content,
          channelId: channel.id,
          channelName: channel.name,
          attachments: attachmentPaths,
          username: message.author.username,
          userid: message.author.id,
          displayname: message.author.displayName,
          created: message.createdAt.toISOString(),
          replyTo: replyTo.id,
        });
        resumed = await this.continueSession({
          entry: sessionEntry,
          channel,
          channelConfig,
          prompt,
          triggerMessageIds: [message.id],
          // !discord reply は元チャンネル上のメッセージに対してのみ有効
          replyToMessageId: message.channelId === channel.id ? message.id : undefined,
        });
      } finally {
        await cleanupFiles(attachmentPaths);
      }
      if (resumed) return;
      await this.notifySessionUnavailable(sessionEntry, replyTo.id, "not_found");
    } else {
      await this.notifySessionUnavailable(sessionEntry, replyTo.id, "expired");
    }

    const referenced = await message.fetchReference().catch(() => undefined);
    await this.processMessage({
      ...item,
      sessionEntry: undefined,
      replyTo: { id: replyTo.id, content: referenced?.content },
    });
  }

  /**
   * 既存のスキルセッションを resume して prompt を送る。
   * 出力したメッセージは対応表に記録し、セッションの期限を延長する。
   * @returns セッションが見つからず再開できなかった場合は false
   */
  private async continueSession(params: {
    entry: LookupResult;
    channel: TextChannel;
    channelConfig: ChannelConfig;
    prompt: string;
    /** 対応表に追加で記録するメッセージ ID（ユーザーのリプライなど） */
    triggerMessageIds: string[];
    replyToMessageId?: string;
  }): Promise<boolean> {
    const { entry, channel, channelConfig, prompt } = params;
    const sentIds: string[] = [];

    const session = new ClaudeSession(
      this.config,
      channelConfig.workdir,
      createDiscordHandler({
        channel,
        isSkillMode: true,
        logChannel: this.logChannel,
        config: this.config,
        enqueue: (msg) => this.enqueueItem({ message: msg, channel, channelConfig, type: "message" }),
        allowAllUsers: channelConfig.allowAllUsers,
        replyToMessageId: params.replyToMessageId,
        onMessageSent: (msg) => sentIds.push(msg.id),
      }),
      entry.sessionId,
    );
    session.onLog = this.makeLogCallback();

    let notFound = false;
    try {
      await this.skillQueue.run(() => session.run(prompt));
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
      notFound = true;
    } finally {
      // エラー終了でも、それまでに出力したメッセージは記録して続きを書けるようにする
      if (!notFound && session.sessionId) {
        this.messageSessions.touch(entry.sessionId);
        this.messageSessions.record(
          [...params.triggerMessageIds, ...sentIds],
          session.sessionId,
          channel.id,
        );
      }
    }

    if (notFound) {
      console.warn(`[Session] Session ${entry.sessionId} not found, removing from message-session map`);
      this.messageSessions.deleteSession(entry.sessionId);
      return false;
    }
    return true;
  }

  private async notifySessionUnavailable(
    entry: LookupResult,
    targetMessageId: string,
    reason: "expired" | "not_found",
  ): Promise<void> {
    const detail = reason === "expired"
      ? `有効期限切れ（最終利用: ${new Date(entry.lastUsedAt).toLocaleString("ja-JP")}）`
      : "セッションが見つかりません";
    const text = `メッセージ ${targetMessageId} のセッションは再開できません: ${detail}`;
    console.log(`[Session] ${text}`);
    await this.logChannel?.send(text).catch(() => {});
  }

  private async processMessage(item: QueuedTextMessage): Promise<void> {
    if (item.sessionEntry && item.replyTo) {
      await this.processSessionReply({ ...item, sessionEntry: item.sessionEntry, replyTo: item.replyTo });
      return;
    }

    const { message, channel, channelConfig } = item;
    const attachmentPaths = await downloadAttachments(message.attachments, channelConfig.workdir);

    // script と skill の両方が定義されている場合は、添付ファイルの有無で切り替え
    const hasAttachments = attachmentPaths.length > 0;
    const shouldUseScript =
      channelConfig.script !== undefined &&
      (channelConfig.skill === undefined || channelConfig.skill === "" || hasAttachments);
    const isScriptMode = shouldUseScript;
    const isSkillMode = isScriptMode || channelConfig.skill !== "";

    // スキルセッションの再開用に、対応表へ記録するメッセージ ID
    const sessionMessageIds = [message.id];

    // スキル/スクリプトモード時はログチャンネルに実行開始を通知
    if ((isSkillMode || isScriptMode) && this.logChannel) {
      const label = isScriptMode ? `スクリプト` : `スキル \`/${channelConfig.skill}\``;
      const notice = await this.logChannel.send(`${message.url} に対して${label}を実行...`);
      sessionMessageIds.push(notice.id);
    }
    try {
      const prompt = buildMessagePrompt({
        id: message.id,
        skill: channelConfig.skill,
        content: message.content,
        channelId: channel.id,
        channelName: channel.name,
        attachments: attachmentPaths,
        username: message.author.username,
        userid: message.author.id,
        displayname: message.author.displayName,
        created: message.createdAt.toISOString(),
        replyTo: item.replyTo?.id,
        replyToContent: item.replyTo?.content,
      });

      const discordHandler = createDiscordHandler({
        channel,
        isSkillMode,
        logChannel: this.logChannel,
        config: this.config,
        enqueue: (msg) => this.enqueueItem({ message: msg, channel, channelConfig, type: "message" }),
        allowAllUsers: channelConfig.allowAllUsers,
        // logChannel 上のリプライから新規実行した場合は、元チャンネルにリプライ先がない
        replyToMessageId: message.channelId === channel.id ? message.id : undefined,
        onMessageSent: (msg) => sessionMessageIds.push(msg.id),
      });

      if (isScriptMode) {
        const session = new ScriptSession(channelConfig.script!, channelConfig.workdir, discordHandler);
        await this.skillQueue.run(() => session.run(prompt));
      } else {
        const session = new ClaudeSession(
          this.config,
          channelConfig.workdir,
          discordHandler,
          isSkillMode ? undefined : this.sessions.getSessionId(channel.id),
        );
        if (!isSkillMode) {
          session.onSessionChange = (id) => this.sessions.setSessionId(channel.id, id);
        }
        session.onLog = this.makeLogCallback();

        if (isSkillMode) {
          try {
            await this.skillQueue.run(() => session.run(prompt));
          } finally {
            if (session.sessionId) {
              this.messageSessions.record(sessionMessageIds, session.sessionId, channel.id);
            }
          }
        } else {
          await session.run(prompt);
        }
      }
    } finally {
      await cleanupFiles(attachmentPaths);
    }
  }

  /**
   * 1つのチャンネルに対してスキルを実行する共通処理。
   */
  private async runInitForChannel(
    channelConfig: ChannelConfig,
    channel: TextChannel,
    skill: string = "init",
    workdir: string = process.cwd(),
  ): Promise<void> {
    const prompt = buildMessagePrompt({
      id: "init",
      skill: skill,
      content: `${channelConfig.name} <#${channel.id}>`,
      channelId: channel.id,
      channelName: channel.name,
      attachments: [],
    });

    const sentIds: string[] = [];
    const session = new ClaudeSession(
      this.config,
      workdir,
      createDiscordHandler({
        channel,
        isSkillMode: true,
        logChannel: this.logChannel,
        config: this.config,
        allowAllUsers: channelConfig.allowAllUsers,
        enqueue: (msg) => this.enqueueItem({ message: msg, channel, channelConfig, type: "message" }),
        onMessageSent: (msg) => sentIds.push(msg.id),
      }),
    );
    session.onLog = this.makeLogCallback();

    try {
      if (skill !== "init") {
        await this.skillQueue.run(() => session.run(prompt));
      } else {
        await session.run(prompt);
      }
    } finally {
      // cron 実行の出力にもリアクション/リプライで続きを指示できるようにする
      if (session.sessionId) {
        this.messageSessions.record(sentIds, session.sessionId, channel.id);
      }
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

    // Filter channels with skill or script configured
    const skillChannels = this.config.channels.filter((ch) => ch.skill !== "" || ch.script !== undefined);
    if (skillChannels.length === 0) {
      console.log("[Init] No channels with skill configured, skipping init");
      return;
    }

    console.log(`[Init] Running init for ${skillChannels.length} channel(s)`);

    for (const channelConfig of skillChannels) {
      // Find the channel by name
      const channel = client.channels.cache.find(
        (ch) => ch instanceof TextChannel && ch.name === channelConfig.name,
      ) as TextChannel | undefined;

      if (!channel) {
        console.log(`[Init] Channel "${channelConfig.name}" not found, skipping`);
        continue;
      }

      try {
        const cmdCtx = { channel, allowedUserId: channelConfig.allowAllUsers ? undefined : this.config.discord.user };

        await processUnhandledMessages({
          channelName: channelConfig.name,
          fetchHistory: async (count, offset) => {
            return await executeHistoryRaw(cmdCtx, count, null, offset);
          },
          enqueueMessage: (message) => {
            //console.log(`enqueue: ${message.author.displayName} : ${message.content}`);
            this.enqueueItem({ message, channel, channelConfig, type: "message" });
          },
        });
      } catch (error) {
        console.error(`[Init] Error for #${channelConfig.name}:`, error);
      }
    }

    console.log("[Init] Init completed for all channels");
  }

  /**
   * cron 設定があるチャンネルについて、実行すべきものを実行する。
   * 起動時（オフライン中に時刻を過ぎた場合の補完）と定期チェックの両方で呼ばれる。
   */
  async checkAndRunCron(client: Client, cronScheduler: CronScheduler): Promise<void> {
    const cronChannels = this.config.channels.filter(
      (ch) => (ch.skill !== "" || ch.script !== undefined) && ch.cron && ch.cron.length > 0,
    );
    if (cronChannels.length === 0) return;

    for (const channelConfig of cronChannels) {
      if (!cronScheduler.shouldRun(channelConfig.name, channelConfig.cron!)) continue;

      const channel = client.channels.cache.find(
        (ch) => ch instanceof TextChannel && ch.name === channelConfig.name,
      ) as TextChannel | undefined;

      if (!channel) {
        console.log(`[Cron] Channel "${channelConfig.name}" not found, skipping`);
        continue;
      }

      console.log(`[Cron] Running /${channelConfig.skill} for #${channelConfig.name}`);
      // 実行前にマーク（二重実行防止）
      cronScheduler.markRan(channelConfig.name);

      try {
        await this.runInitForChannel(channelConfig, channel, channelConfig.skill, channelConfig.workdir);
        console.log(`[Cron] Completed for #${channelConfig.name}`);
      } catch (error) {
        console.error(`[Cron] Error for #${channelConfig.name}:`, error);
      }
    }
  }
}
