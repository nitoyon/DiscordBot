import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, TextChannel } from "discord.js";
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

  client.on("clientReady", async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    // Register slash commands
    const commands = [
      new SlashCommandBuilder()
        .setName("clear")
        .setDescription("セッションを初期化します")
        .toJSON(),
    ];
    const rest = new REST({ version: "10" }).setToken(config.discord.token);
    try {
      await rest.put(Routes.applicationCommands(client.user!.id), { body: commands });
      console.log("Registered slash commands");
    } catch (err) {
      console.error("Failed to register slash commands:", err);
    }

    // Run init skill for all channels with skill configured
    await channelQueue.runInit(client);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "clear") {
      sessions.deleteSessionId(interaction.channelId);
      await interaction.reply("セッションを初期化しました。");
    }
  });

  client.on("messageCreate", (message) => {
    channelQueue.enqueueMessage(message);
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
