import { describe, it, expect, vi } from "vitest";
import {
  determineUnprocessedMessages,
  fetchUnprocessedMessages,
  type FetchHistoryFn,
} from "./init-processor.js";
import type { Message } from "discord.js";

const createMessage = (
  id: string,
  reactions: string[] = []
): Message => {
  const reactionCache = new Map(
    reactions.map((emoji) => [
      emoji,
      { emoji: { name: emoji, toString: () => emoji } },
    ])
  );

  return {
    id,
    reactions: {
      cache: reactionCache,
    },
  } as any as Message;
};

describe("determineUnprocessedMessages", () => {

  describe("メッセージが0件の場合", () => {
    it("空リストを返す", () => {
      const result = determineUnprocessedMessages([], false);
      expect(result).toEqual({
        unprocessedMessages: [],
        needMoreHistory: false,
      });
    });
  });

  describe("一番古いメッセージに✅がついている場合", () => {
    it("✅なしメッセージのみを古い順で返す", () => {
      // 新しい順: [3=未処理, 2=未処理, 1=処理済み]
      const messages = [
        createMessage("3"),
        createMessage("2"),
        createMessage("1", ["✅"]),
      ] as Message[];

      const result = determineUnprocessedMessages(messages, false);
      expect(result.unprocessedMessages.map(m => m.id)).toEqual(["2", "3"]); // 古い順
      expect(result.needMoreHistory).toBe(false);
    });

    it("全て処理済みの場合は空リストを返す", () => {
      const messages = [
        createMessage("3", ["✅"]),
        createMessage("2", ["✅"]),
        createMessage("1", ["✅"]),
      ] as Message[];

      const result = determineUnprocessedMessages(messages, false);
      expect(result).toEqual({
        unprocessedMessages: [],
        needMoreHistory: false,
      });
    });

    it("👀と✅の両方がある場合は処理済みとみなす", () => {
      const messages = [
        createMessage("2", ["👀"]),
        createMessage("1", ["👀", "✅"]),
      ] as Message[];

      const result = determineUnprocessedMessages(messages, false);
      expect(result.unprocessedMessages.map(m => m.id)).toEqual(["2"]);
      expect(result.needMoreHistory).toBe(false);
    });
  });

  describe("一番古いメッセージに✅がついていない場合", () => {
    it("hasMore=true の場合、さらに履歴が必要と判断する", () => {
      const messages = [
        createMessage("3"),
        createMessage("2"),
        createMessage("1"), // ✅なし
      ] as Message[];

      const result = determineUnprocessedMessages(messages, true);
      expect(result).toEqual({
        unprocessedMessages: [],
        needMoreHistory: true,
      });
    });

    it("hasMore=false の場合、全未処理メッセージを返す", () => {
      const messages = [
        createMessage("3"),
        createMessage("2"),
        createMessage("1"), // ✅なし
      ] as Message[];

      const result = determineUnprocessedMessages(messages, false);
      expect(result.unprocessedMessages.map(m => m.id)).toEqual(["1", "2", "3"]);
      expect(result.needMoreHistory).toBe(false);
    });
  });

  describe("実践的なシナリオ", () => {
    it("ボットオフライン中に3件投稿された場合", () => {
      const messages = [
        createMessage("103"),
        createMessage("102"),
        createMessage("101"),
        createMessage("100", ["✅"]), // 最後に処理したメッセージ
      ] as Message[];

      const result = determineUnprocessedMessages(messages, false);
      expect(result.unprocessedMessages.map(m => m.id)).toEqual(["101", "102", "103"]);
      expect(result.needMoreHistory).toBe(false);
    });

    it("履歴取得件数内に✅がない場合、さらに遡る", () => {
      // 100件取得したが全て未処理
      const messages = Array.from({ length: 100 }, (_, i) =>
        createMessage(`${100 - i}`)
      ) as Message[];

      const result = determineUnprocessedMessages(messages, true);
      expect(result).toEqual({
        unprocessedMessages: [],
        needMoreHistory: true,
      });
    });

    it("初めての起動(履歴すべて未処理、hasMore=false)", () => {
      const messages = [
        createMessage("3"),
        createMessage("2"),
        createMessage("1"),
      ] as Message[];

      const result = determineUnprocessedMessages(messages, false);
      expect(result.unprocessedMessages.map(m => m.id)).toEqual(["1", "2", "3"]);
      expect(result.needMoreHistory).toBe(false);
    });
  });
});

describe("fetchUnprocessedMessages", () => {
  const createMessages = (
    messages: Array<{ id: string; reactions?: string[] }>
  ): Message[] => {
    return messages.map((msg) => createMessage(msg.id, msg.reactions ?? []));
  };

  it("1回の履歴取得で✅が見つかった場合", async () => {
    const fetchHistory: FetchHistoryFn = vi.fn(async (count, offset) => {
      expect(count).toBe(100);
      expect(offset).toBe(0);
      return createMessages([
        { id: "3" },
        { id: "2" },
        { id: "1", reactions: ["✅"] },
      ]);
    });

    const result = await fetchUnprocessedMessages(fetchHistory);
    expect(result.map(m => m.id)).toEqual(["2", "3"]);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("2回目の履歴取得で✅が見つかった場合", async () => {
    const fetchHistory: FetchHistoryFn = vi.fn(async (count, offset) => {
      if (offset === 0) {
        // 100件全て未処理
        const messages = Array.from({ length: 100 }, (_, i) => ({
          id: `${200 - i}`,
        }));
        return createMessages(messages);
      } else {
        // offset=100: 古いメッセージに✅あり
        return createMessages([
          { id: "100" },
          { id: "99", reactions: ["✅"] },
        ]);
      }
    });

    const result = await fetchUnprocessedMessages(fetchHistory);
    expect(result.map(m => m.id)).toEqual(["100", ...Array.from({ length: 100 }, (_, i) => `${101 + i}`)]);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("全て処理済みの場合は空リストを返す", async () => {
    const fetchHistory: FetchHistoryFn = vi.fn(async () => {
      return createMessages([
        { id: "3", reactions: ["✅"] },
        { id: "2", reactions: ["✅"] },
        { id: "1", reactions: ["✅"] },
      ]);
    });

    const result = await fetchUnprocessedMessages(fetchHistory);
    expect(result).toEqual([]);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("取得件数が100件未満の場合はそれ以上遡らない", async () => {
    const fetchHistory: FetchHistoryFn = vi.fn(async () => {
      return createMessages([
        { id: "50" },
        { id: "49" },
        // ... 50件のみ (100件未満)
      ]);
    });

    const result = await fetchUnprocessedMessages(fetchHistory);
    // hasMore=false なので、全て未処理として返す
    expect(result.map(m => m.id)).toEqual(["49", "50"]);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("最大試行回数に達した場合", async () => {
    const fetchHistory: FetchHistoryFn = vi.fn(async (count, offset) => {
      // 常に100件の未処理メッセージを返す
      const start = 1000 - offset;
      const messages = Array.from({ length: 100 }, (_, i) => ({
        id: `${start - i}`,
      }));
      return createMessages(messages);
    });

    const result = await fetchUnprocessedMessages(fetchHistory);
    // 最大4回試行
    expect(fetchHistory).toHaveBeenCalledTimes(4);
    // すべての未処理メッセージが返される (4回 × 100件 = 400件)
    expect(result.length).toBe(400);
  });

  it("履歴が空の場合", async () => {
    const fetchHistory: FetchHistoryFn = vi.fn(async () => {
      return [];
    });

    const result = await fetchUnprocessedMessages(fetchHistory);
    expect(result).toEqual([]);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("実践的なシナリオ: ボット再起動後に5件の未処理メッセージ", async () => {
    const fetchHistory: FetchHistoryFn = vi.fn(async (count, offset) => {
      expect(offset).toBe(0);
      return createMessages([
        { id: "105" },
        { id: "104" },
        { id: "103" },
        { id: "102" },
        { id: "101" },
        { id: "100", reactions: ["👀", "✅"] },
        { id: "99", reactions: ["✅"] },
      ]);
    });

    const result = await fetchUnprocessedMessages(fetchHistory);
    expect(result.map(m => m.id)).toEqual(["101", "102", "103", "104", "105"]);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });
});
