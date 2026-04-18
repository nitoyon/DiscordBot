import { describe, it, expect } from "vitest";
import {
  parseChannelRef,
  parseResponseText,
  HeredocState,
} from "./response-line-parser.js";

describe("parseChannelRef", () => {
  it("parses <#123456> format", () => {
    expect(parseChannelRef("<#123456789>")).toBe("123456789");
  });

  it("parses #channel-name format", () => {
    expect(parseChannelRef("#general")).toBe("general");
    expect(parseChannelRef("#my-channel")).toBe("my-channel");
  });

  it("returns as-is for unknown format", () => {
    expect(parseChannelRef("plain")).toBe("plain");
  });
});

describe("HeredocState", () => {
  it("starts inactive", () => {
    const state = new HeredocState();
    expect(state.isActive()).toBe(false);
  });

  it("becomes active after start", () => {
    const state = new HeredocState();
    state.start("EOF", "send");
    expect(state.isActive()).toBe(true);
    expect(state.getDelimiter()).toBe("EOF");
  });

  it("collects lines and ends", () => {
    const state = new HeredocState();
    state.start("EOF", "send");

    state.addLine("line1");
    state.addLine("line2");

    const result = state.end();
    expect(result).toEqual({
      type: "discord_send",
      message: "line1\nline2",
    });
    expect(state.isActive()).toBe(false);
  });

  it("stores channel for sendto", () => {
    const state = new HeredocState();
    state.start("END", "sendto", "general");

    state.addLine("content");
    const result = state.end();
    expect(result).toEqual({
      type: "discord_sendto",
      channel: "general",
      message: "content",
    });
  });

  it("handles reply command", () => {
    const state = new HeredocState();
    state.start("EOF", "reply");

    state.addLine("reply message");
    const result = state.end();
    expect(result).toEqual({
      type: "discord_reply",
      message: "reply message",
    });
  });
});

describe("parseResponseText", () => {
  describe("single line !discord send", () => {
    it("parses simple message", () => {
      const result = parseResponseText("!discord send Hello World");

      expect(result).toEqual([
        { type: "discord_send", message: "Hello World" },
      ]);
    });

    it("parses message with special characters", () => {
      const result = parseResponseText("!discord send メッセージ: 処理中...");

      expect(result).toEqual([
        { type: "discord_send", message: "メッセージ: 処理中..." },
      ]);
    });
  });

  describe("single line !discord reply", () => {
    it("parses simple reply message", () => {
      const result = parseResponseText("!discord reply Hello there!");

      expect(result).toEqual([
        { type: "discord_reply", message: "Hello there!" },
      ]);
    });

    it("parses reply message with special characters", () => {
      const result = parseResponseText("!discord reply メッセージ: 確認しました");

      expect(result).toEqual([
        { type: "discord_reply", message: "メッセージ: 確認しました" },
      ]);
    });
  });

  describe("single line !discord sendto", () => {
    it("parses with #channel format", () => {
      const result = parseResponseText("!discord sendto #general Hello");

      expect(result).toEqual([
        { type: "discord_sendto", channel: "general", message: "Hello" },
      ]);
    });

    it("parses with <#id> format", () => {
      const result = parseResponseText("!discord sendto <#123456789> Message here");

      expect(result).toEqual([
        { type: "discord_sendto", channel: "123456789", message: "Message here" },
      ]);
    });

    it("parses with #id format", () => {
      const result = parseResponseText("!discord sendto #123456789 Test");

      expect(result).toEqual([
        { type: "discord_sendto", channel: "123456789", message: "Test" },
      ]);
    });
  });

  describe("heredoc !discord send", () => {
    it("parses heredoc message", () => {
      const text = `!discord send <<EOF
line1
line2
EOF`;
      const result = parseResponseText(text);

      expect(result).toEqual([
        { type: "discord_send", message: "line1\nline2" },
      ]);
    });

    it("works with custom delimiter", () => {
      const text = `!discord send <<MYEND
content
MYEND`;
      const result = parseResponseText(text);

      expect(result).toEqual([
        { type: "discord_send", message: "content" },
      ]);
    });
  });

  describe("heredoc !discord reply", () => {
    it("parses heredoc reply message", () => {
      const text = `!discord reply <<EOF
multi
line
reply
EOF`;
      const result = parseResponseText(text);

      expect(result).toEqual([
        { type: "discord_reply", message: "multi\nline\nreply" },
      ]);
    });
  });

  describe("heredoc !discord sendto", () => {
    it("parses heredoc with channel", () => {
      const text = `!discord sendto #general <<EOF
multi
line
EOF`;
      const result = parseResponseText(text);

      expect(result).toEqual([
        { type: "discord_sendto", channel: "general", message: "multi\nline" },
      ]);
    });
  });

  describe("mixed content", () => {
    it("parses text with send commands", () => {
      const text = `Some text here
!discord send 進捗報告
More text
!discord reaction 123456789 👍`;

      const result = parseResponseText(text);

      expect(result).toEqual([
        { type: "text", content: "Some text here" },
        { type: "discord_send", message: "進捗報告" },
        { type: "text", content: "More text" },
        { type: "discord_reaction", messageId: "123456789", emoji: "👍", remove: false },
      ]);
    });

    it("parses heredoc in mixed content", () => {
      const text = `!discord send <<EOF
複数行
メッセージ
EOF
通常のテキスト`;

      const result = parseResponseText(text);

      expect(result).toEqual([
        { type: "discord_send", message: "複数行\nメッセージ" },
        { type: "text", content: "通常のテキスト" },
      ]);
    });

    it("parses multiple send commands", () => {
      const text = `!discord send 最初のメッセージ
!discord sendto #general 別チャンネル
!discord send <<EOF
ヒアドキュメント
EOF`;

      const result = parseResponseText(text);

      expect(result).toEqual([
        { type: "discord_send", message: "最初のメッセージ" },
        { type: "discord_sendto", channel: "general", message: "別チャンネル" },
        { type: "discord_send", message: "ヒアドキュメント" },
      ]);
    });
  });

  describe("edge cases", () => {
    it("handles empty heredoc", () => {
      const text = `!discord send <<EOF
EOF`;
      const result = parseResponseText(text);

      expect(result).toEqual([
        { type: "discord_send", message: "" },
      ]);
    });

    it("handles heredoc with empty lines", () => {
      const text = `!discord send <<EOF
line1

line3
EOF`;
      const result = parseResponseText(text);

      expect(result).toEqual([
        { type: "discord_send", message: "line1\n\nline3" },
      ]);
    });
  });

  describe("existing commands", () => {
    it("parses discord nop", () => {
      const result = parseResponseText("!discord nop");
      expect(result).toEqual([{ type: "discord_nop" }]);
    });

    it("parses discord reaction add", () => {
      const result = parseResponseText("!discord reaction 123456789 👍");
      expect(result).toEqual([
        { type: "discord_reaction", messageId: "123456789", emoji: "👍", remove: false },
      ]);
    });

    it("parses discord reaction remove", () => {
      const result = parseResponseText("!discord reaction 123456789 -👀");
      expect(result).toEqual([
        { type: "discord_reaction", messageId: "123456789", emoji: "👀", remove: true },
      ]);
    });

    it("parses discord history", () => {
      const result = parseResponseText("!discord history 20 offset:10");
      expect(result).toEqual([
        { type: "discord_history", count: 20, channelId: null, offset: 10 },
      ]);
    });

    it("parses discord delete", () => {
      const result = parseResponseText("!discord delete 123456789");
      expect(result).toEqual([
        { type: "discord_delete", messageId: "123456789" },
      ]);
    });

    it("parses discord exec", () => {
      const result = parseResponseText("!discord exec 123456789");
      expect(result).toEqual([
        { type: "discord_exec", messageId: "123456789" },
      ]);
    });

    it("parses media", () => {
      const result = parseResponseText("media: .tmp/image.png");
      expect(result).toEqual([
        { type: "media", filePath: ".tmp/image.png" },
      ]);
    });

    it("parses reactions", () => {
      const result = parseResponseText("reactions: 1️⃣2️⃣");
      expect(result).toEqual([
        { type: "reactions", emojis: ["1️⃣", "2️⃣"] },
      ]);
    });
  });
});
