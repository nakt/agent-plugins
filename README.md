# nakt-tools

個人利用向け Claude Code プラグインのマーケットプレイス。1 リポジトリ = 1 マーケットプレイス方針で、`plugins/<plugin-name>/` 配下に機能単位のプラグインを並置している。

普段使いの skill を個人用プラグインとして運用してみたらどうなるか、といった検証も兼ねているので、中身は気ままに増減する。

## 使い方

Claude Code 上で、このリポジトリをマーケットプレイスとして登録し、必要なプラグインをインストールする。

```shell
# 1. マーケットプレイスを登録
/plugin marketplace add nakt/agent-plugins

# 2. プラグインをインストール
/plugin install <plugin-name>@nakt-tools

# 3. 更新を取り込む
/plugin marketplace update nakt-tools
```

ローカルのクローン先を指定する場合は、`add` の引数を GitHub リポジトリ名の代わりに絶対パスにする (例: `/plugin marketplace add /path/to/agent-plugins`)。

## プラグイン一覧

| プラグイン      | 説明                                                                                     | source                       |
| --------------- | ---------------------------------------------------------------------------------------- | ---------------------------- |
| document-tools  | ドキュメントの作成やレビューを支援する skill 集。draft-service-brief などを含む。         | `./plugins/document-tools`   |

## 開発 / コントリビュート

プラグインの追加・更新・削除の作法、命名規約、`plugin.json` の version bump ルールは `.claude/skills/plugin-authoring/SKILL.md` に集約している。Claude Code 上でこのリポジトリを開いていれば、該当する発話 (「プラグインを追加したい」等) で自動的に skill が起動する。

## 参考リンク

- プラグイン開発ガイド: <https://code.claude.com/docs/en/plugins>
- プラグイン技術仕様: <https://code.claude.com/docs/en/plugins-reference>
- マーケットプレイスの作成と配布: <https://code.claude.com/docs/en/plugin-marketplaces>
