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
  | { type: "discord_send"; message: string }
  | { type: "discord_sendto"; channel: string; message: string }
  | { type: "discord_nop" };

const NOP_RE = /^!discord\s+nop$/;
const REACTION_RE = /^!discord\s+reaction\s+(\d+)\s+(-?)(.+)$/;
const HISTORY_RE = /^!discord\s+history(.*)$/;
const DELETE_RE =
  /^!discord\s+delete\s+(?:https:\/\/discord\.com\/channels\/\d+\/\d+\/(\d+)|(\d+))$/;
const EXEC_RE = /^!discord\s+exec\s+(\d+)$/;
const MEDIA_RE = /^media:\s+(.+)$/;
const REACTIONS_RE = /^reactions:\s+(.+)$/;
const SEND_RE = /^!discord\s+send\s+(.+)$/;
const SENDTO_RE = /^!discord\s+sendto\s+(<#(\d+)>|#(\S+))\s+(.+)$/;
const HEREDOC_START_RE = /^<<(\w+)$/;

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

/**
 * チャンネル指定文字列からチャンネル識別子を抽出
 * - <#123456> → 123456
 * - #channel-name → channel-name
 */
export function parseChannelRef(ref: string): string {
  // <#123456> 形式
  const mentionMatch = ref.match(/^<#(\d+)>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }
  // #で始まる場合は # を除去
  if (ref.startsWith("#")) {
    return ref.slice(1);
  }
  return ref;
}

/**
 * ヒアドキュメントの状態を管理するクラス
 */
export class HeredocState {
  private delimiter: string | null = null;
  private lines: string[] = [];
  private commandType: "send" | "sendto" | null = null;
  private channel: string | undefined = undefined;

  isActive(): boolean {
    return this.delimiter !== null;
  }

  start(delimiter: string, commandType: "send" | "sendto", channel?: string): void {
    this.delimiter = delimiter;
    this.commandType = commandType;
    this.channel = channel;
    this.lines = [];
  }

  addLine(line: string): void {
    this.lines.push(line);
  }

  end(): ParsedLine {
    const message = this.lines.join("\n");
    const commandType = this.commandType!;
    const channel = this.channel;

    // リセット
    this.delimiter = null;
    this.lines = [];
    this.commandType = null;
    this.channel = undefined;

    if (commandType === "sendto" && channel) {
      console.log(`[Discord] !discord sendto #${channel} (heredoc, ${message.split("\n").length} lines)`);
      return { type: "discord_sendto", channel, message };
    }
    console.log(`[Discord] !discord send (heredoc, ${message.split("\n").length} lines)`);
    return { type: "discord_send", message };
  }

  getDelimiter(): string | null {
    return this.delimiter;
  }
}

function parseLine(line: string, heredocState: HeredocState): ParsedLine | null {
  // ヒアドキュメント処理中の場合
  if (heredocState.isActive()) {
    const delimiter = heredocState.getDelimiter()!;

    // デリミタと一致したら終了
    if (line === delimiter) {
      return heredocState.end();
    }

    // 継続（結果を返さない）
    heredocState.addLine(line);
    return null;
  }

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

  // !discord sendto のマッチ（send より先にチェック）
  m = line.match(SENDTO_RE);
  if (m) {
    const channelRef = m[1];
    const channel = parseChannelRef(channelRef);
    const content = m[4];

    // ヒアドキュメント開始チェック
    const heredocMatch = content.match(HEREDOC_START_RE);
    if (heredocMatch) {
      const delimiter = heredocMatch[1];
      heredocState.start(delimiter, "sendto", channel);
      return null; // ヒアドキュメント開始時は結果を返さない
    }

    console.log(`[Discord] !discord sendto #${channel} ${content}`);
    return { type: "discord_sendto", channel, message: content };
  }

  // !discord send のマッチ
  m = line.match(SEND_RE);
  if (m) {
    const content = m[1];

    // ヒアドキュメント開始チェック
    const heredocMatch = content.match(HEREDOC_START_RE);
    if (heredocMatch) {
      const delimiter = heredocMatch[1];
      heredocState.start(delimiter, "send");
      return null; // ヒアドキュメント開始時は結果を返さない
    }

    console.log(`[Discord] !discord send ${content}`);
    return { type: "discord_send", message: content };
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
  const lines = text.split("\n");
  const result: ParsedLine[] = [];
  const heredocState = new HeredocState();

  for (const line of lines) {
    const parsed = parseLine(line, heredocState);
    if (parsed !== null) {
      result.push(parsed);
    }
  }

  return result;
}
