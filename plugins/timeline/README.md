# timeline

サブエージェントの起動、その中のツール呼び出し、タスクのバッチ、コミットを、`git log --graph` のような見た目でチャットの横のペインに表示する mod。

```text
1: 今回   2: 過去

開始 2026-11-16 15:11 · エージェント 3 · コミット 1 · バッチ 1
  15:13:43 │ ✔    5607ce0 Add c
▾ 15:13:41 │ ●    general-purpose 「Create c.txt and commit」 claude-haiku-5-5 · tools 1 · 5s · APPROVED
    15:13:43  Bash  echo c > c.txt && git add c.txt && git commit -q -m "Add c"
▸ 15:11:23 │ │ ●  general-purpose 「Cat README and report」 claude-haiku-5-5 · tools 1 · 2s · NEEDS_CHANGES
▸ 15:11:21 │ ●    general-purpose 「Run ls and report」 claude-haiku-5-5 · tools 1 · 2s · APPROVED
  15:11:18 ◆      バッチ 1 · 2/2 完了 · ファイル a を作る, ファイル b を作る
```

## 何を表示するか

各行は「時刻 · レーン · 内容」で、新しい行が上に来る。記号は次のとおり。

| 記号 | 意味                                                                               |
| ---- | ---------------------------------------------------------------------------------- |
| `●`  | サブエージェントの起動。種類、説明、モデル、ツール呼び出しの数、かかった時間、判定 |
| `✔`  | `git commit`。サブエージェントがしたコミットは、そのエージェントのレーンに置く     |
| `◆`  | バッチ。`in_progress` になったタスクのまとまり                                     |
| `│`  | その時点で動いていたエージェントのレーン。同じ時間帯に動いたエージェントは横に並ぶ |

- `▸` を押すと、そのエージェント内のツール呼び出しを開く (`▾` で閉じる)
- 判定は、サブエージェントの戻り値の文字列に最後に出てきた `APPROVED` / `NEEDS_CHANGES`
- execute-plan に限らず、Agent の起動はすべて記録する。execute-plan 側の変更は要らない

## 推測のしかた

- **バッチ**: `TaskUpdate` で `in_progress` になったタスクを、開いているバッチに加える。開いているバッチがなければ新しく始める。バッチのタスクがすべて `completed` (または `deleted`) になったらバッチを閉じる
- **並列**: エージェントは起動時に空いているレーンをもらい、ターンの終わりにレーンを返す
- **コミット**: Bash のコマンドが `git commit` で成功したとき。出力の `[branch sha] subject` を読み、なければ `git log -1` で HEAD を読む

## 使い方

```shell
/plugin install timeline@nakt-tools
```

セッションの開始時にペインを開く。手で開いたことがない間は、端末の幅が 144 桁以上あるときだけ表示される (一度 `/timeline` で開けば 110 桁から)。

| コマンド          | 動作                                       |
| ----------------- | ------------------------------------------ |
| `/timeline`       | ペインを開き、キーボードのフォーカスを移す |
| `/timeline past`  | 過去の実行の一覧を開く                     |
| `/timeline close` | ペインを閉じる                             |

ペインにフォーカスがあるとき、`1` / `2` でタブを切り替え、Tab で行を移って Enter で開閉する。Esc でプロンプトに戻る。

## 保存

- 今のセッションの記録は `$.state` に置く。mod を再読み込みしても残り、`/clear` で新しい実行になる
- メインのターンが終わるたびと、セッションの終了時に `$.store` へ保存する。直近 20 回分を残し、古いものから消す
- 1 回の実行で記録するのは行とツール呼び出しを合わせて 2,000 件まで。超えた分は数だけ数える
- 保存するときは、1 エージェントあたりのツール呼び出しを新しい 40 件に絞る

## 開発

Claude Code v2.1.325 で確かめている。

```shell
claude --plugin-dir ./plugins/timeline   # 読み込んで動かす (保存すると再読み込み)
claude plugin validate ./plugins/timeline
cd plugins/timeline && claude plugin test
cd plugins/timeline && tsc -p .
```

`tsconfig.json` は、Claude Code が `--plugin-dir` で読み込んだときに生成する `.claude-plugin/types/` を参照する。この型定義は Claude Code のバージョンごとに変わるので git には入れていない。型チェックの前に一度、対話セッションで読み込んでおく。

| ファイル            | 内容                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `hooks/register.ts` | フック (`agent.spawn` / `tool.call` / `turn.complete` / `session.*` / `command.run` / `ui.render`) と保存 |
| `hooks/model.ts`    | 記録と推測の純粋な関数。`$` に触れない                                                                    |
| `types/index.d.ts`  | `$.state` に置く値の型                                                                                    |
| `tests/`            | `claude plugin test` で動くテスト                                                                         |
