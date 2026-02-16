import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

export interface Config {
  discord: { token: string; user: string };
  claude: { model: string };
  channels: { name: string; skill: string; workdir: string }[];
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
  for (const ch of data.channels) {
    if (!ch.name || typeof ch.skill !== "string") {
      throw new Error("Each channel must have name and skill");
    }
    ch.workdir = ch.workdir ? resolve(ch.workdir) : process.cwd();
  }

  return data as Config;
}
