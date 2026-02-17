# Discord Bot with Claude Code CLI

## Quickstart

1. 次のツールをインストール
  - [Node.js](https://nodejs.org/) (>=22)
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

2. [Discord Developer Portal](https://discord.com/developers/applications) でボットを作成

3. セットアップ:
   ```bash
   npm install
   ```

4. `.env.yaml` ファイルを作成（`.env.yaml.example` を参考）:
   ```env
   discord:
     token: <Your Token Here>
     user: "<Your User ID Here>"
   
   channels:
     - name: エナジーメモ
       skill: daily-strength
       dir: ../skills
     - name: 料理メモ
       skill: dish-strength
       dir: ../skills
   ```

5. 起動:
   ```bash
   npm start
   ```

## 開発

```bash
# テスト
npm test

# リント（ESLint + 型チェック）
npm run lint
```

## License

MIT

## 謝辞

https://github.com/karaage0703/xangi の設計思想を参照させていただいています。
