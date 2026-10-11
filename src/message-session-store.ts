import { readFileSync, writeFileSync } from "fs";

const DEFAULT_FILE = ".message-sessions.json";
const DEFAULT_MAX_ENTRIES = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MessageSessionEntry {
  sessionId: string;
  /** セッションを開始した元のチャンネル ID (logChannel 上のメッセージでも元チャンネル) */
  channelId: string;
  lastUsedAt: number;
}

export interface LookupResult extends MessageSessionEntry {
  /** TTL を過ぎている (まだ物理削除はされていない) */
  expired: boolean;
}

export interface MessageSessionStoreOptions {
  ttlDays: number;
  /** null のときは永続化しない (テスト用) */
  file?: string | null;
  maxEntries?: number;
  now?: () => number;
}

/**
 * Bot が投稿したメッセージ ID と Claude のセッション ID の対応表。
 * スキルモードの使い捨てセッションに、リアクションやリプライで再開するために使う。
 *
 * - TTL 内: 再開可能
 * - TTL 〜 TTL*2: 期限切れとして返す (ユーザーへの案内用に残す)
 * - TTL*2 超: 物理削除
 */
export class MessageSessionStore {
  private entries = new Map<string, MessageSessionEntry>();
  private ttlMs: number;
  private file: string | null;
  private maxEntries: number;
  private now: () => number;

  constructor(options: MessageSessionStoreOptions) {
    this.ttlMs = options.ttlDays * DAY_MS;
    this.file = options.file === undefined ? DEFAULT_FILE : options.file;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.load();
    if (this.prune() > 0) this.save();
  }

  get size(): number {
    return this.entries.size;
  }

  record(messageIds: string[], sessionId: string, channelId: string): void {
    if (messageIds.length === 0) return;
    const lastUsedAt = this.now();
    for (const id of messageIds) {
      this.entries.set(id, { sessionId, channelId, lastUsedAt });
    }
    this.prune();
    this.save();
  }

  lookup(messageId: string): LookupResult | undefined {
    const entry = this.entries.get(messageId);
    if (!entry) return undefined;
    const age = this.now() - entry.lastUsedAt;
    if (age > this.ttlMs * 2) return undefined;
    return { ...entry, expired: age > this.ttlMs };
  }

  /** 同じセッションに属する全エントリの期限を延長する */
  touch(sessionId: string): void {
    const now = this.now();
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) {
        entry.lastUsedAt = now;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** セッションが再開できなくなったときに、そのセッションのエントリをまとめて削除する */
  deleteSession(sessionId: string): void {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /**
   * TTL*2 を超えたエントリと、上限件数を超えた古いエントリを削除する。
   * @returns 削除した件数
   */
  prune(): number {
    const before = this.entries.size;
    const threshold = this.now() - this.ttlMs * 2;
    for (const [id, entry] of this.entries) {
      if (entry.lastUsedAt < threshold) this.entries.delete(id);
    }

    if (this.entries.size > this.maxEntries) {
      const sorted = [...this.entries].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
      for (const [id] of sorted.slice(0, this.entries.size - this.maxEntries)) {
        this.entries.delete(id);
      }
    }
    return before - this.entries.size;
  }

  /** 定期実行用: 削除があればファイルに保存する */
  pruneAndSave(): void {
    if (this.prune() > 0) this.save();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = readFileSync(this.file, "utf-8");
      const data = JSON.parse(raw) as Record<string, MessageSessionEntry>;
      for (const [k, v] of Object.entries(data)) {
        if (typeof v?.sessionId !== "string" || typeof v?.channelId !== "string") continue;
        if (typeof v.lastUsedAt !== "number") continue;
        this.entries.set(k, v);
      }
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  private save(): void {
    if (!this.file) return;
    const obj: Record<string, MessageSessionEntry> = {};
    for (const [k, v] of this.entries) {
      obj[k] = v;
    }
    writeFileSync(this.file, JSON.stringify(obj, null, 2) + "\n");
  }
}
