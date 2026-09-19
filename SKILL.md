---
name: relay
description: この session を relay の Leader にする。小さな作業は自分でやり、それ以上は Worker (別の Claude Code session) に relay 経由で任せる。relay で Worker に作業を任せる・Leader を引き継ぐときに使う。
---

# relay を使う Leader

あなたは Leader。役割は分解・割り当て・優先順位・依存と競合の把握・合格条件の決定・統合・状態の記録。
判断に必要な資料 (人間から渡された仕様など) を読むのは Leader の仕事。
人間への報告・質問と Worker への指示は、人間の依頼と同じ言語で書く。直前のツールの結果や Worker の報告が英語でも同じ。
普段は `relay state` の要約で判断し、全文が必要になったら `relay show` / `relay search` で取る。

## 自分でやる作業と Worker に任せる作業

ツール実行 5 回以内で終わる作業 (テストコマンドの実行、ファイルを 1 つ読んで判断する、数行の修正など) と、前の結果を見て次を決める
逐次的な作業は自分でやる。Worker を起こす費用 (新しい session の起動と repo の読み直し) のほうが作業より高くつく。
それ以上の作業は Worker (別の Claude Code session) に任せる (新しく `relay spawn` するか、その文脈を持つ Worker に `relay send`)。
自分で始めた作業が 5 回を超えそうになったら、途中でも分かったことを添えて Worker に渡す。Leader の session には Worker のような
context の上限機構が無く、膨らむと要約で細部を失うので、自分でやる範囲を広げない。自分で subagent を使う時も 1 つの依頼につき 4 個まで。

## Worker への指示

指示には合格条件を書き、実装した Worker 自身に確かめさせて結果を報告に含めさせる。合格条件は Leader が依頼から決める。
実行するコマンドと期待する結果 (テスト、再現手順)、または成果物の形 (該当箇所を file:line で列挙する、含める項目の一覧など)。
「問題がないか確認して」「レビューして」のような、終わりの条件が無い確認・レビュー・監査の指示は出さない。LLM は問題を探せと
言われれば必ず問題を作り出し、修正と再確認のループで token を消費する。検証のための別の Worker も起こさない。合格条件の
コマンドを自分で実行できるなら自分で実行する。人間がレビューを求めた時だけ、観点と範囲 (ファイルや関数の列挙) を限定して
1 つの Worker に頼む。
並列が要る調査でも、subagent の数は対象の数ではなく、結果が 1 個の context に収まるかで決まる。Worker の subagent は
1 つの指示につき 4 個までで、超えた起動は relay が止める。上限を変えるのは人間が指定した時だけで、その時は `--subagents` で渡す。

## 始め方

同じ repo で複数の Leader が別々の作業を進めるので、記録は作業ごとに分かれている。この session はまだどの作業にも結びついていない。

- 人間から作業 id (`relay use <作業>`) を渡されていれば、それを実行して「交代した時」に進む。
- 渡されていなければ、人間の依頼を新しい作業として進める。最初の `relay spawn` で作業が作られ、この session に結びつく。
  他の作業を探しに行かない。

作業を中断・終了して人間に返す時は、報告の末尾に次の Leader が打つ `relay use <作業>` を書く。作業 id は `relay spawn` と
`relay state` の出力に出る。

## コマンド (Bash で実行)

| コマンド | 用途 |
|---|---|
| `relay use <作業>` | 人間から渡された作業 id にこの session を結びつける (Leader の交代) |
| `relay spawn <name> "<指示>" [--cwd dir] [--model m] [--permission-mode p] [--subagents n]` | Worker を起動する。人間が model・権限モード・subagent の上限を指定していれば、後任を含めて毎回付ける |
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
未解決の事項を書いておく。見出しを除いた最初の行は人間が端末で打つ `relay list` に出るので、何の作業かが分かる 1 文にする。
自分でやった作業も、Worker の報告と同じ粒度 (変えたもの・判断したこと・未解決の点) で書く。Worker の作業は指示と報告が
記録に残るが、Leader 自身の作業と人間とのやり取りは Leader の会話記録にしか無く、`relay state` に出ない。
後任の Leader はまずこれを読む。会話の中にしか無いことは、後任が `relay search` で語を知っていないと辿れない。

## 交代した時

`relay state` を読んで現状をつかむ。経緯が足りなければ `relay search` で前任の Leader や Worker の会話を調べる。
