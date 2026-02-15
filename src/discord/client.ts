import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import type { Config } from "../config.js";
import type { SessionManager } from "../session-manager.js";
import { ChannelQueue } from "./channel-queue.js";

export function createDiscordClient(
  config: Config,
  sessions: SessionManager,
): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const channelQueue = new ChannelQueue(config, sessions);

  client.on("clientReady", () => {
    console.log(`Logged in as ${client.user?.tag}`);
  });

  client.on("messageCreate", (message) => {
    if (message.author.bot) return;
    if (message.author.id !== config.discord.user.toString()) return;

    if (!(message.channel instanceof TextChannel)) return;
    const channel = message.channel;

    const channelConfig = config.channels.find(
      (ch) => ch.name === channel.name,
    );
    if (!channelConfig) return;

    console.log(
      `[Discord] #${channel.name} ${message.author.username}: ${message.content}`,
    );

    channelQueue.enqueue({ message, channel, channelConfig });
  });

  return client;
}
