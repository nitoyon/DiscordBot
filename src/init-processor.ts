/**
 * init処理: ボット起動時に未処理メッセージを検出する
 *
 * 使い方の例:
 * ```typescript
 * import { processUnhandledMessages } from './init-processor.js';
 * import { executeHistoryRaw, executeExec } from './discord/command-executor.js';
 *
 * // 起動時に未処理メッセージを検出して処理
 * await processUnhandledMessages({
 *   channelName: channelConfig.name,
 *   fetchHistory: async (count, offset) => {
 *     return await executeHistoryRaw(cmdCtx, count, null, offset);
 *   },
 *   fetchMessage: async (messageId) => {
 *     return await executeExec(cmdCtx, messageId);
 *   },
 *   enqueueMessage: (message) => {
 *     this.enqueueItem({ message, channel, channelConfig, type: "message" });
 *   },
 * });
 * ```
 */

import type { Message } from "discord.js";

/**
 * 履歴取得の最大試行回数 (デフォルト: 4回まで遡る = 最大400件)
 */
const MAX_HISTORY_ATTEMPTS = 4;

/**
 * 1回の履歴取得件数
 */
const HISTORY_BATCH_SIZE = 100;

/**
 * 履歴取得コールバックの型定義
 * @param count - 取得件数
 * @param offset - オフセット
 * @returns Message の配列 (新しい順)
 */
export type FetchHistoryFn = (count: number, offset: number) => Promise<Message[]>;

/**
 * メッセージをキューに追加するコールバックの型定義
 */
export type EnqueueMessageFn = (message: Message) => void;

/**
 * 未処理メッセージ処理のオプション
 */
export interface ProcessUnhandledMessagesOptions {
  /** チャンネル名 (ログ出力用) */
  channelName: string;
  /** 履歴取得関数 */
  fetchHistory: FetchHistoryFn;
  /** メッセージをキューに追加する関数 */
  enqueueMessage: EnqueueMessageFn;
}

/**
 * 未処理メッセージを検出して処理する
 *
 * @param options - 処理オプション
 * @returns 処理したメッセージ数
 */
export async function processUnhandledMessages(
  options: ProcessUnhandledMessagesOptions
): Promise<number> {
  const { channelName, fetchHistory, enqueueMessage } = options;

  console.log(`[Init] Running init for #${channelName}`);

  try {
    // 未処理メッセージを取得
    const unprocessedMessages = await fetchUnprocessedMessages(fetchHistory);

    if (unprocessedMessages.length === 0) {
      console.log(`[Init] No unprocessed messages in #${channelName}`);
      return 0;
    }

    console.log(`[Init] Found ${unprocessedMessages.length} unprocessed message(s) in #${channelName}`);

    // 未処理メッセージを古い順に処理
    for (const message of unprocessedMessages) {
      console.log(`[Init] Processing message ${message.id} in #${channelName}`);
      enqueueMessage(message);
    }

    console.log(`[Init] Completed init for #${channelName} (processed ${unprocessedMessages.length} messages)`);
    return unprocessedMessages.length;
  } catch (error) {
    console.error(`[Init] Error running init for #${channelName}:`, error);
    throw error;
  }
}

/**
 * 未処理メッセージのリストを決定する
 *
 * @param messages - `!discord history` から取得したメッセージ (新しい順)
 * @param hasMore - さらに古いメッセージが存在する可能性があるか
 * @returns { unprocessedMessages: 処理すべきメッセージリスト (古い順), needMoreHistory: さらに古い履歴が必要か }
 */
export function determineUnprocessedMessages(
  messages: Message[],
  hasMore: boolean
): { unprocessedMessages: Message[]; needMoreHistory: boolean } {
  if (messages.length === 0) {
    return { unprocessedMessages: [], needMoreHistory: false };
  }

  // 新しい順に並んでいるので、末尾(=古い方)から✅があるかチェック
  const oldestMessage = messages[messages.length - 1];
  const reactions = Array.from(oldestMessage.reactions.cache.values()).map((r) => r.emoji.name ?? r.emoji.toString());
  const hasCheckmark = reactions.includes('✅');

  // 古いメッセージに✅がついていない場合、さらに古いメッセージを取得する必要がある
  if (!hasCheckmark && hasMore) {
    return { unprocessedMessages: [], needMoreHistory: true };
  }

  // ✅がついていないメッセージを抽出 (古い順にするため reverse)
  const unprocessed = messages
    .filter(msg => {
      const msgReactions = Array.from(msg.reactions.cache.values()).map((r) => r.emoji.name ?? r.emoji.toString());
      return !msgReactions.includes('✅');
    })
    .reverse();

  return {
    unprocessedMessages: unprocessed,
    needMoreHistory: false,
  };
}

/**
 * 未処理メッセージを取得する (履歴を段階的に遡りながら)
 *
 * @param fetchHistory - 履歴取得関数
 * @returns 未処理メッセージリスト (古い順)
 */
export async function fetchUnprocessedMessages(
  fetchHistory: FetchHistoryFn
): Promise<Message[]> {
  let offset = 0;
  let attempt = 0;
  const allMessages: Message[] = [];

  while (attempt < MAX_HISTORY_ATTEMPTS) {
    const messages = await fetchHistory(HISTORY_BATCH_SIZE, offset);

    // 新しく取得したメッセージを追加 (新しい順に並んでいる)
    allMessages.push(...messages);

    // 取得したメッセージ数がバッチサイズ未満なら、これ以上古いメッセージはない
    const hasMore = messages.length === HISTORY_BATCH_SIZE;

    const result = determineUnprocessedMessages(allMessages, hasMore);

    if (!result.needMoreHistory) {
      return result.unprocessedMessages;
    }

    // さらに古い履歴を取得
    offset += HISTORY_BATCH_SIZE;
    attempt++;
  }

  // 最大試行回数に達した場合、収集したすべてのメッセージから未処理分を返す
  console.warn(
    `[init-processor] Reached max history attempts (${MAX_HISTORY_ATTEMPTS}), processing available messages`
  );
  const finalResult = determineUnprocessedMessages(allMessages, false);
  return finalResult.unprocessedMessages;
}
