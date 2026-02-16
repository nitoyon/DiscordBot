import { Client, GatewayIntentBits, Partials, TextChannel } from "discord.js";
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
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction],
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

  client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;
    if (user.id !== config.discord.user.toString()) return;

    // Fetch partial reaction/message if needed
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (err) {
        console.error("[Discord] Failed to fetch partial reaction:", err);
        return;
      }
    }
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch (err) {
        console.error("[Discord] Failed to fetch partial message:", err);
        return;
      }
    }

    if (!(reaction.message.channel instanceof TextChannel)) return;
    const channel = reaction.message.channel;

    const channelConfig = config.channels.find(
      (ch) => ch.name === channel.name,
    );
    if (!channelConfig) return;

    const emoji = reaction.emoji.name ?? reaction.emoji.toString();
    console.log(
      `[Discord] #${channel.name} ${user.username} reacted: ${emoji}`,
    );

    channelQueue.enqueueReaction({
      emoji,
      targetMessageId: reaction.message.id,
      channelId: channel.id,
      channel,
      channelConfig,
    });
  });

  return client;
}
