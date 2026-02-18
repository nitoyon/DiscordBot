export type ParsedLine =
  | { type: "text"; content: string }
  | { type: "media"; filePath: string }
  | { type: "reactions"; emojis: string[] }
  | {
      type: "discord_reaction";
      messageId: string;
      emoji: string;
      remove: boolean;
    }
  | {
      type: "discord_history";
      count: number;
      channelId: string | null;
      offset: number;
    }
  | { type: "discord_delete"; messageId: string }
  | { type: "discord_exec"; messageId: string }
  | { type: "discord_nop" };

const NOP_RE = /^!discord\s+nop$/;
const REACTION_RE = /^!discord\s+reaction\s+(\d+)\s+(-?)(.+)$/;
const HISTORY_RE = /^!discord\s+history(.*)$/;
const DELETE_RE =
  /^!discord\s+delete\s+(?:https:\/\/discord\.com\/channels\/\d+\/\d+\/(\d+)|(\d+))$/;
const EXEC_RE = /^!discord\s+exec\s+(\d+)$/;
const MEDIA_RE = /^media:\s+(.+)$/;
const REACTIONS_RE = /^reactions:\s+(.+)$/;

function splitEmojis(emojiString: string): string[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const segments = [...segmenter.segment(emojiString)];
  return segments
    .map((s) => s.segment)
    .filter((s) => s.trim().length > 0);
}

function parseHistoryArgs(argsStr: string): {
  count: number;
  channelId: string | null;
  offset: number;
} {
  const args = argsStr.trim();
  let count = 10;
  let channelId: string | null = null;
  let offset = 0;

  if (!args) return { count, channelId, offset };

  const tokens = args.split(/\s+/);
  for (const token of tokens) {
    const offsetMatch = token.match(/^offset:(\d+)$/);
    const channelMatch = token.match(/^<#(\d+)>$/);
    if (offsetMatch) {
      offset = parseInt(offsetMatch[1], 10);
    } else if (channelMatch) {
      channelId = channelMatch[1];
    } else if (/^\d+$/.test(token)) {
      count = Math.min(parseInt(token, 10), 100);
    }
  }

  return { count, channelId, offset };
}

function parseLine(line: string): ParsedLine {
  let m: RegExpMatchArray | null;

  if (NOP_RE.test(line)) {
    console.log(`[Discord] !discord nop`);
    return { type: "discord_nop" };
  }

  m = line.match(REACTION_RE);
  if (m) {
    console.log(`[Discord] !discord reaction ${m[1]} ${m[2]}${m[3]}`);
    return {
      type: "discord_reaction",
      messageId: m[1],
      emoji: m[3].trim(),
      remove: m[2] === "-",
    };
  }

  m = line.match(HISTORY_RE);
  if (m) {
    const { count, channelId, offset } = parseHistoryArgs(m[1]);
    console.log(`[Discord] !discord history: channel=${channelId}, count=${count}, offset=${offset}`);
    return { type: "discord_history", count, channelId, offset };
  }

  m = line.match(DELETE_RE);
  if (m) {
    console.log(`[Discord] !discord delete: ${m[1]}, ${m[2]}`);
    return { type: "discord_delete", messageId: m[1] ?? m[2] };
  }

  m = line.match(EXEC_RE);
  if (m) {
    console.log(`[Discord] !discord exec ${m[1]}`);
    return { type: "discord_exec", messageId: m[1] };
  }

  m = line.match(MEDIA_RE);
  if (m) {
    console.log(`[Discord] media ${m[1]}`);
    return { type: "media", filePath: m[1].trim() };
  }

  m = line.match(REACTIONS_RE);
  if (m) {
    console.log(`[Discord] reactions ${m[1]}`);
    return { type: "reactions", emojis: splitEmojis(m[1]) };
  }

  console.log(`[Discord] text ${line}`);
  return { type: "text", content: line };
}

export function parseResponseText(text: string): ParsedLine[] {
  return text.split("\n").map(parseLine);
}
