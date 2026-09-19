# relay

Leader と Worker の間に立つ proxy と記録装置。Leader は普通の Claude Code session で、Worker (Claude Code の
background session) とは `relay` を通してやり取りする。Leader と Worker は記録から入れ替えられる。

```text
Leader (claude) ──Bash: relay spawn / send / state / show / search / wait──▶ relay ──claude --bg / --resume──▶ Worker
                                                                              ▲                                 │
                                                                              └──── Worker の Stop hook (報告) ─┘
                                                                              │
                                                                              ▼
                                                                         .relay/ (記録)
```

## 記録 (`<repo>/.relay/<作業>/`、git の除外に自動で入る)

同じ repo で複数の Leader が別々の作業を進められるように、記録は作業ごとに分ける。作業 id は最初の `relay spawn` で自動で
振られ、Leader の session はその作業に結びつく (`.relay/sessions/<session id>`)。以降のコマンドはその作業だけを扱う。
Worker の worktree は `.relay/<作業>/wt/<name>`、branch は `relay/<作業>/<name>`。

| 層 | 場所 | 中身 |
|---|---|---|
| state | `workers/<name>.json`、`notes.md` | Worker の状態・今の指示の要約・直近の報告の要約・session・worktree。Leader が書く管理メモ |
| 詳細 | `log.jsonl`、各 session の transcript | 指示と報告の全文、停止などの出来事。Worker と歴代 Leader の会話 (transcript は Claude Code 自身のものを参照) |

Leader は普段 `relay state` だけを見て、必要な時に `relay show` / `relay search` で詳細を取る。

## 使い方

```sh
cd relay                                                                 # relay のディレクトリで実行する
chmod +x relay.js && ln -s "$PWD/relay.js" ~/bin/relay                   # PATH の通った場所に置く (Node.js 24+)
mkdir -p ~/.claude/skills && ln -s "$PWD" ~/.claude/skills/relay         # /relay で使う skill (User scope)

cd /path/to/repo
claude                                                                   # 起動して /relay を実行し、やりたいことを話す
```

- Leader の使い方は `SKILL.md`。`/relay` を実行するか、relay を使うと話した session が Leader になる。Worker は repo の
  中の worktree で動くので、Leader の指示を CLAUDE.md に書くと Worker も常に読んでしまう。
- 複数の作業: 別の session で `/relay` を実行して依頼すれば、別の作業として記録・通知・branch が分かれる。
- Leader の交代: 新しい `claude` で `/relay` を実行する。Leader が `relay list` で引き継ぎ候補 (Leader がいなくなり Worker が
  残っている作業) を見つけたら、新しい作業にするか、どれを引き継ぐかを人間に聞く。引き継いだ Leader は `relay state` と
  `notes.md` で現状をつかみ、経緯は `relay search` で前任の Leader や Worker の会話から調べる。
- 端末から見る: `relay list`、`relay state` (全作業)、`relay state --work <作業>`。
- Worker を覗く・話す: `relay attach <name>` (= `claude attach`)。抜けても Worker は動き続ける。
- 権限モードを付けずに起動した Worker は、権限の確認で止まる。`relay state` と `relay wait` に
  `waiting: permission prompt` として出るので、`relay attach` で応答する。無人で動かすなら `--permission-mode` を付ける。
- Leader を `claude --bg` で動かす時は `--settings '{"worktree":{"bgIsolation":"none"}}'` を付ける
  (付けないと repo 本体のファイル編集が拒否される)。

## 頼っている Claude Code の挙動 (2.1.270 で確認)

- `claude --bg` は `--session-id` を無視する。出力の short id (色の制御文字を含むことがある) で job を指す
- フラグなしの `claude --bg --resume <session id> "<指示>"` は、起動時に保存したオプション (hooks・追加の system prompt・
  model・権限モード) のまま同じ session を起こす。フラグを付けるか、`claude stop` の後でプロセスが終わる前に実行すると、
  オプションの無い copy (別 session) になる。relay は止めてプロセスの終了を待ち、フラグなしで再開する
- `claude rm` で job を消すと、保存した起動時のオプションも消える。relay は job が無い Worker を再開する時だけ、フラグを付けて
  `--resume` する (会話を引き継いだ copy になる)
- `claude agents --json` の `status` は idle / busy / waiting で、`waitingFor` に待っているもの (例: permission prompt) が入る
- PostToolUse hook が `hookSpecificOutput.additionalContext` を返すと、ツールの結果に添えて Claude に渡る。作業中に届いた指示は
  ここで渡すので、Worker が次にツールを使い終えた時点で届く (並列に出したツールはまとめて終わった後。2.1.272 で確認)
- Stop hook の入力に `session_id`・`transcript_path`・`last_assistant_message`・`background_tasks` が入る。
  `{"decision":"block","reason":...}` を返すと止まらずに続ける (ツールを使わずに区切りまで来た時の指示をここで渡す)。
  `background_tasks` には動いている subagent が入るが、SendMessage で再開した subagent は入らない。relay は transcript の
  `resumedAgentId` と `<task-id>` で、再開した subagent の答えを待っている区切りを見分けて報告にしない
- Leader が `run_in_background` で実行したコマンドが終わると、Claude Code が Leader に通知する (`relay wait` の 1 行が届く)
- 落ちた background session は supervisor が同じ id で起こし直し、作業を続ける
- Claude Code の中から起動したプロセスは親の `CLAUDE_CODE_*` 環境変数を継承し、子の transcript が保存されない (relay は消して起動する)
- Leader・他の Worker との session 間のやり取りは relay を通す。Worker は `crossSessionInbound: "refuse"` で他の session からの
  メッセージを断り、SendMessage の宛先が `claude agents` に出る session なら PreToolUse hook で止める (bypassPermissions でも効く)。
  自分の subagent への SendMessage (agentId 宛て) は session 内なので通る (2.1.272 で確認)
- statusLine のコマンドは bg session でも動き、入力の `context_window.used_percentage` に context の使用率が入る。relay は Worker に
  自前の statusLine を付けて使用率を記録し、70% で Worker に区切りでの報告を求め、Leader に知らせる (Worker の画面の
  statusline は relay のものになる。人間の session には影響しない)
- Leader の Bash には `CLAUDE_CODE_SESSION_ID` が入る。relay はこれで Leader の session を作業に結びつける

## 作っていないもの

daemon、MCP server、task の依存管理、自動の分解・割当・完了判定・交代。判断と管理は Leader が行う。

## ライセンス

MIT (`LICENSE`)
