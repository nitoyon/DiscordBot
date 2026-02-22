import { readFileSync, writeFileSync } from "fs";

interface CronState {
  [channelName: string]: string; // ISO timestamp of last run
}

/**
 * クロン実行状態を管理するクラス。
 * 最終実行時刻をファイルに永続化し、次回実行すべきかどうかを判断する。
 */
export class CronScheduler {
  private state: CronState = {};
  private readonly statePath: string;

  constructor(statePath = ".cron-state.json") {
    this.statePath = statePath;
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.statePath, "utf-8");
      this.state = JSON.parse(raw);
    } catch {
      // ファイルが存在しない場合は空の状態から開始
    }
  }

  private save(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  getLastRun(channelName: string): Date | null {
    const ts = this.state[channelName];
    return ts ? new Date(ts) : null;
  }

  markRan(channelName: string): void {
    this.state[channelName] = new Date().toISOString();
    this.save();
  }

  /**
   * 指定したチャンネルを今すぐ実行すべきか判断する。
   * cronTimes に "HH:MM" 形式の時刻リストを渡す。
   *
   * ロジック:
   * - 直近に通過した予定時刻（now 以前で最新）を求める
   * - 最終実行時刻がその予定時刻より前であれば実行すべき
   * - 一度も実行していない場合は実行すべき
   */
  shouldRun(channelName: string, cronTimes: string[]): boolean {
    const now = new Date();
    const mostRecent = getMostRecentScheduledTime(cronTimes, now);
    if (!mostRecent) return false;

    const lastRun = this.getLastRun(channelName);
    if (!lastRun) return true;
    return lastRun < mostRecent;
  }
}

/**
 * cronTimes (["HH:MM", ...]) のうち、now 以前で最も直近の日時を返す。
 * 今日のその時刻が未来の場合は昨日の同時刻を候補とする。
 */
function getMostRecentScheduledTime(cronTimes: string[], now: Date): Date | null {
  let best: Date | null = null;

  for (const t of cronTimes) {
    const [hh, mm] = t.split(":").map(Number);

    const candidate = new Date(now);
    candidate.setHours(hh, mm, 0, 0);

    // 未来の場合は昨日の同時刻にずらす
    if (candidate > now) {
      candidate.setDate(candidate.getDate() - 1);
    }

    if (!best || candidate > best) {
      best = candidate;
    }
  }

  return best;
}