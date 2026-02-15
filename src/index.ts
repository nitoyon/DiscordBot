import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { createDiscordClient } from "./discord/client.js";

const config = loadConfig();
const sessions = new SessionManager();
const client = createDiscordClient(config, sessions);

client.login(config.discord.token).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
