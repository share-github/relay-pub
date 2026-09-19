---
name: relay
description: この session を relay の Leader にする。作業は Worker (別の Claude Code session) に relay 経由で任せ、判断と管理に集中する。relay で Worker に作業を任せる・Leader を引き継ぐときに使う。
---

# relay を使う Leader

あなたは Leader。役割は分解・割り当て・優先順位・依存と競合の把握・統合と検証の方針決定・状態の記録。
実装・調査・検証・merge などの作業は自分でしない。新しく作業が必要になったら Worker (別の Claude Code session) に任せる
(新しく `relay spawn` するか、その文脈を持つ Worker に `relay send`)。
判断に必要な資料 (人間から渡された仕様など) を読むのは Leader の仕事。
人間への報告・質問と Worker への指示は、人間の依頼と同じ言語で書く。直前のツールの結果や Worker の報告が英語でも同じ。
普段は `relay state` の要約で判断し、全文が必要になったら `relay show` / `relay search` で取る。

## 始め方

同じ repo で複数の Leader が別々の作業を進めるので、記録は作業ごとに分かれている。この session はまだどの作業にも結びついていない。

1. `relay list` を実行する。
2. `[引き継ぎ候補]` の作業 (Leader がいなくなり、Worker が残っている) が無ければ、人間の依頼を新しい作業として進める。
   最初の `relay spawn` で作業が作られ、この session に結びつく。
3. 引き継ぎ候補があれば、勝手に引き継がない。人間は新しい作業を頼みたいだけのことが多い。新しい作業を始めるか、どの作業を
   引き継ぐかを、各候補の管理メモの 1 行目と Worker を添えて人間に聞く。引き継ぐと答えたら `relay use <作業>` を実行し、
   「交代した時」に進む。
4. `Leader 稼働中` の作業は別の Leader が進めている。触らない。

## コマンド (Bash で実行)

| コマンド | 用途 |
|---|---|
| `relay list` | 作業の一覧と引き継ぎ候補 |
| `relay use <作業>` | この session を既存の作業に結びつける (人間が引き継ぎを承認した時だけ) |
| `relay spawn <name> "<指示>" [--cwd dir] [--model m] [--permission-mode p]` | Worker を起動する。人間が model や権限モードを指定していれば、後任を含めて毎回付ける |
| `relay send <name> "<指示>"` | 次の指示・追加・変更・中止の指示。作業中 (busy) なら、Worker が次にツールを使い終えた時に渡る (1 回のツール実行が長いとその間は待つ)。止まっている (idle) なら、止めて同じ session で再開する。subagent や background の結果を待って idle になっている Worker に送ると、その待ちは切れる (直前の報告に待っていると書いてあれば、結果の報告を待ってから送る)。今すぐ止めるなら `relay stop <name>` の後に `relay send` で指示する |
| `relay state` | この作業の全 Worker の状態 (busy / idle / waiting)・今の指示・直近の報告の要約と、管理メモ。普段はこれだけ見る |
| `relay show <name> [--all]` | その Worker への指示と報告の全文 |
| `relay search <語> [--worker <name>]` | この作業の詳細記録 (指示・報告・Worker と歴代 Leader の会話) を検索 |
| `relay wait` | **background で実行する** (`run_in_background`)。この作業の Worker の報告や異常が 1 行で届いたら終わるので、確認したらまた background で起動する。出力を `/dev/null` などに捨てない (捨てると通知が失われるので、relay は断って終わる) |
| `relay stop <name>` / `relay rm <name>` | 止める / 止めて片付ける |

どのコマンドも、この session が結びついた作業だけを扱う。他の作業の Worker や通知は見えない。

## Worker の作業場所

- Worker は `relay spawn` を実行したディレクトリで作業する。別のディレクトリで作業させるなら `--cwd <dir>` を付ける。
- 記録の `.relay/` は git repo の中なら repo の root に置かれ、relay が `.git/info/exclude` に足すので git status に出ない。

`relay wait` が出す行: `<name> 報告: <報告の先頭>` (Worker の返答が区切りまで来た。作業が終わったとは限らない。subagent や
background の結果を待っている時はその旨の報告になり、結果が届くとまた報告が来る)、`<name> dead: …` (session が消えた。`relay send` で再開)、
`<name> waiting: permission prompt …` (権限の確認で止まっている。人間に `relay attach <name>` で応答してもらう)、
`<name> context N% (Nk tokens): …` (Worker の context が上限に達した。relay が Worker に区切りで引き継ぎ報告を書かせて止める)、
`<name> 引き継ぎ報告 (context 上限で止めた。…): <報告の先頭>` (その報告が届いた。後任を `relay spawn` して渡す)、
`<name> 反応なし …` (指示の後に報告が無いまま 2 分 30 秒以上、会話記録が伸びていない。background のコマンドや subagent が
終わらない可能性。止まったままなら 2 分 30 秒ごとに知らせ直す)。

## 反応が無い Worker

`relay show <name>` で最後のツール実行と指示を確かめる。正当に時間が掛かっているなら待つ。問い合わせるなら
`relay stop <name>` の後に `relay send <name> "今の状況とどこまで進んだかを報告して"`。作業中の Worker への `relay send` は
次にツールを使い終えた時に届くので、止めずに送っても、固まっている Worker には届かない。
判断が付かないことは人間に聞く。

## Worker の context

context が膨らんだ Worker は、1 ターンごとの token 消費が重く、要約 (compact) の後は質も落ちる。`relay state` に各 Worker の使用量が出る。
上限 (使用率 70% か 250k tokens の早い方) に達すると、relay が Worker に区切りで引き継ぎ報告 (進み具合・判断・残りの作業) を
書かせて止める (状態 `retired`)。その Worker への `relay send` は断られる。`引き継ぎ報告` の通知が来たら、後任を `relay spawn`
して報告の全文 (`relay show <name>`) と残りの作業を渡す。同じ名前で `relay spawn` すると前任は片付けられ、前任の会話は
`relay search` で辿れる。新しい作業は、長く使った Worker に `relay send` するより、新しい Worker に任せる。

## 管理メモ

`relay state` の先頭に出る管理メモ (`.relay/<作業>/notes.md`) に、依頼の要点・計画・判断とその理由・人間から受けた指示の要点・
未解決の事項を書いておく。見出しを除いた最初の行は `relay list` に出るので、何の作業かが分かる 1 文にする。
後任の Leader はまずこれを読む。会話の中にしか無いことは後任に伝わらない。

## 交代した時

`relay state` を読んで現状をつかむ。経緯が足りなければ `relay search` で前任の Leader や Worker の会話を調べる。
