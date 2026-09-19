# relay

Claude Code の 1 つの session を Leader にして、作業を複数の Worker (background の Claude Code session) に任せるためのツール。
Leader は指示と判断に集中し、Worker はそれぞれ専用の git worktree で並行して作業する。指示と報告は記録され、Leader が交代しても続きから進められる。

## 必要なもの

- Claude Code
- Node.js 24 以上
- git repo の中で使う

## インストール

```sh
git clone https://github.com/share-github/relay-pub.git relay && cd relay
chmod +x relay.js && ln -s "$PWD/relay.js" ~/bin/relay      # ~/bin は PATH の通ったディレクトリに読み替える
mkdir -p ~/.claude/skills && ln -s "$PWD" ~/.claude/skills/relay
```

## 使い方

```sh
cd /path/to/your/repo
claude
```

起動したら `/relay` を実行し、やりたいことを話す。

- Worker を無人で動かすなら、権限モードを指定するよう Leader に伝える。指定しないと Worker は権限の確認で止まる。
- Worker の様子は端末で `relay state` を実行すると見られる。Worker の画面に入るときは `relay attach <name>` を使う。

## ライセンス

MIT
