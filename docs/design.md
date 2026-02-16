# 設計ドキュメント

## 概要

DiscordBot プロセスは、起動すると `discord.token` で Discord に接続し、
参加しているチャンネルへのメッセージを監視する

メッセージが新規に作成されたときには、次の処理を実施する。

## アーキテクチャ

ユーザー入力

```
User → Discord → DiscordBot → Claude API
```

Claude API からのレスポンス (!discord コマンドの場合)

```
Claude API → DiscordBot → Discord API
           ←
```

Claude API からのレスポンス (通常メッセージ)

```
Claude API → DiscordBot → Discord API → ユーザー
```

## セッションの管理

- 基本的にはチャンネルごとの既存のセッションを流用する
- チャンネルに対するセッションがないときは、新規のセッションを作成する
- 新規のセッションの開始時には `<system-context>\n[docs/PROMPT.mdの中身]\n</system-context>\n` をプロンプトの冒頭に付与する

## メッセージ入力時の流れ

```
1. ユーザーがメッセージ送信
   ↓
2. DiscordBotが受信
   ↓
3. 権限チェック
   - `discord.user` と一致するか
   - `channels` のいずれかの `name` と一致するか
   ↓
4. Claude APIに転送
   - プロンプト文の作成
   ↓
5. レスポンス処理
   - メッセージ取得
   - ファイル添付抽出
   - !discord 検出・実行 (この場合は 4. に戻る)
   ↓
6. ユーザーに返信
```

### プロンプト文の作成

- 発言者が `discord.user` の ID と一致しない場合は処理をスキップ
- 発言されたチャンネルが `channels` のうちのいずれかの `name` と一致するか確認する。一致しなければ処理をスキップする
- 発言に画像が含まれる場合は、`.tmp` フォルダに一時的な名前でファイルをダウンロードする
- プロンプトを実行する。
    - 発言の先頭に `skill` に記載されているスキル名をつける
    - 現在のディレクトリは `dir` に記載されているディレクトリに設定する。省略時はプロジェクトルート。

プロンプトの例

```
id: 1469254290685165578
content: /skill-name text
channel: 1464624036071080082
attachments: .tmp/xxxx .tmp/yyyy
reactions:
```

## ユーザーリアクション時の流れ

- DiscordBot の発言に対するリアクション、かつ、`discord.user` からのリアクションの場合のみ、処理を行う
- プロンプト文を作成して、Claude API 経由で既存のセッションに通知する

```
id: 1469254290685165578
channel: 1464624036071080082
reactions: 2️⃣
```
