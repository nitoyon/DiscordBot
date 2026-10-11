import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

const DEFAULT_SESSION_TTL_DAYS = 7;
/** Claude Code がセッション履歴を自動削除するまでの既定日数 (cleanupPeriodDays) */
const CLAUDE_CLEANUP_PERIOD_DAYS = 30;

export interface Config {
  discord: { token: string; user: string; logChannel?: string; sessionTtlDays: number };
  claude: { model: string };
  channels: { name: string; skill: string; script?: string; workdir: string; cron?: string[]; allowAllUsers?: boolean }[];
}

export function loadConfig(path = ".env.yaml"): Config {
  const raw = readFileSync(path, "utf-8");
  const data = parse(raw);

  if (!data?.discord?.token) throw new Error("discord.token is required");
  if (!data?.discord?.user) throw new Error("discord.user is required");
  if (!data?.claude?.model) throw new Error("claude.model is required");
  if (!Array.isArray(data?.channels) || data.channels.length === 0) {
    throw new Error("channels must be a non-empty array");
  }
  if (data.discord.sessionTtlDays === undefined) {
    data.discord.sessionTtlDays = DEFAULT_SESSION_TTL_DAYS;
  } else if (typeof data.discord.sessionTtlDays !== "number" || data.discord.sessionTtlDays <= 0) {
    throw new Error("discord.sessionTtlDays must be a positive number");
  } else if (data.discord.sessionTtlDays >= CLAUDE_CLEANUP_PERIOD_DAYS) {
    console.warn(
      `[Config] discord.sessionTtlDays (${data.discord.sessionTtlDays}) >= ${CLAUDE_CLEANUP_PERIOD_DAYS}: ` +
      "Claude Code の cleanupPeriodDays でセッションが削除され、再開できない場合があります",
    );
  }
  if (process.env?.DISCORD) {
    data.discord.token = process.env.DISCORD;
  }
  for (const ch of data.channels) {
    if (!ch.name) {
      throw new Error("Each channel must have name");
    }
    if (ch.script !== undefined && typeof ch.script !== "string") {
      throw new Error(`Channel "${ch.name}": script must be a string`);
    }
    if (ch.skill !== undefined && typeof ch.skill !== "string") {
      throw new Error(`Channel "${ch.name}": skill must be a string`);
    }
    // script も skill も未定義の場合はエラー
    if (ch.script === undefined && ch.skill === undefined) {
      throw new Error(`Channel "${ch.name}": must have either skill or script`);
    }
    if (ch.skill === undefined) ch.skill = "";
    ch.workdir = ch.workdir ? resolve(ch.workdir) : process.cwd();
    if (ch.cron !== undefined) {
      if (!Array.isArray(ch.cron)) {
        throw new Error(`Channel "${ch.name}": cron must be an array`);
      }
      for (const t of ch.cron) {
        if (!/^\d{2}:\d{2}$/.test(t)) {
          throw new Error(`Channel "${ch.name}": invalid cron time "${t}", must be HH:MM`);
        }
      }
    }
  }

  return data as Config;
}
