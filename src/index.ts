import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { MessageSessionStore } from "./message-session-store.js";
import { createDiscordClient } from "./discord/client.js";

const config = loadConfig();
const sessions = new SessionManager();
const messageSessions = new MessageSessionStore({ ttlDays: config.discord.sessionTtlDays });
const client = createDiscordClient(config, sessions, messageSessions);

client.login(config.discord.token).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
