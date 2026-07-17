---
name: plugin-authoring
description: この agent-plugins repo (nakt-tools マーケットプレイス) で、プラグインの追加・機能追加・更新・削除を行うときのワークフローと命名規約、ディレクトリ構成、plugin.json の version bump ルールを提供する skill。「プラグインを追加したい」「新しい skill を足したい」「plugin.json の version をどう上げる」「プラグインを削除したい」「hooks.json をどこに置く」といった依頼で使う。他リポジトリの Claude Code プラグイン開発全般 (公式 plugin-dev バンドルがカバーする一般的な作法) には使わない。
---

# plugin-authoring

## 概要

この repo (agent-plugins) は 1 リポジトリ = 1 マーケットプレイスで、`.claude-plugin/marketplace.json` の `name` フィールドで `nakt-tools` と定義される。マーケットプレイス配下の `plugins/<plugin-name>/` が個別プラグイン (install / uninstall の単位) で、各プラグインは自身の manifest と skill / agent / command / hook / MCP server を持つ。この skill は「プラグインをどう追加・変更・削除するか」の作法を集約する。

## ディレクトリ構成

```text
agent-plugins/                                    # repo (git 管理単位)
├── .claude-plugin/
│   └── marketplace.json                          # マーケットプレイス定義 (name: nakt-tools)
└── plugins/                                      # 各プラグインを並置 (metadata.pluginRoot で解決)
    └── <plugin-name>/                            # プラグイン (install/uninstall の単位)
        ├── .claude-plugin/plugin.json            # プラグイン manifest
        ├── skills/<skill-name>/SKILL.md          # skill (複数可)
        ├── agents/*.md                           # agent (任意)
        ├── commands/*.md                         # command (任意)
        ├── hooks/                                # hook (任意、プラグイン単位で 1 箇所)
        │   ├── hooks.json
        │   └── scripts/                          # hook から呼ぶスクリプト
        └── scripts/                              # プラグイン全体で共有するスクリプト (任意)
```

## 命名規約 (すべて必須)

- マーケットプレイス manifest は `.claude-plugin/marketplace.json` に置く。各 plugin エントリの `source` は `./plugins/<plugin-name>` 形式で書く (公式仕様上 Relative path 型の string は `./` で始まる必要がある。`metadata.pluginRoot` の糖衣は使わない — Claude Code のバージョンによっては「source type not supported」エラーになる)
- 各プラグイン manifest は `plugins/<plugin-name>/.claude-plugin/plugin.json`
- skill は `plugins/<plugin-name>/skills/<skill-name>/SKILL.md` の階層固定。ファイル名 `SKILL.md` は変更不可。skill 付随のリソースは同ディレクトリ配下の `references/` などに置く
- hook はプラグイン単位で 1 つの `hooks/hooks.json` に集約する。skill 別のサブディレクトリは切らない (skill 別の hook が必要なら matcher とスクリプト名で分ける)
- hook 用スクリプトは `plugins/<plugin-name>/hooks/scripts/`、プラグイン全体で共有するスクリプトは `plugins/<plugin-name>/scripts/` に置く
- プラグイン内から自身のファイルを参照するときは `${CLAUDE_PLUGIN_ROOT}` を使う。ハードコードした絶対パス・ホーム相対パスは使わない
- プラグイン名 / skill 名 / agent 名 / command 名はすべて kebab-case
- プラグイン名は「機能単位」で命名する。含まれる主 skill 名と同一でも構わない

## プラグイン追加ワークフロー

新しいプラグインを追加する手順:

1. `plugins/<plugin-name>/.claude-plugin/plugin.json` を作成する。`version` は `"0.1.0"` で開始
2. 主 skill を `plugins/<plugin-name>/skills/<skill-name>/SKILL.md` に作成する (`references/` があれば同じディレクトリ配下に)
3. `.claude-plugin/marketplace.json` の `plugins[]` に 1 エントリ追加する。フィールドは `name` / `source` / `description` の 3 つが最低限 (`source` は `<plugin-name>` の 1 語で書ける)

plugin.json のテンプレート:

```json
{
  "name": "<plugin-name>",
  "description": "<1 文で>",
  "version": "0.1.0",
  "author": {
    "name": "Tetsuo Nakamura",
    "email": "tetsuo.nakamura@gmail.com"
  }
}
```

## 機能追加ワークフロー (skill / agent / command / hook)

既存プラグインに機能を足すときの置き場所:

- skill 追加: `plugins/<name>/skills/<new-skill>/SKILL.md` (ディレクトリを新設。ファイル名は `SKILL.md` 固定)
- agent 追加: `plugins/<name>/agents/<agent-name>.md`
- command 追加: `plugins/<name>/commands/<command-name>.md`
- hook 追加: `plugins/<name>/hooks/hooks.json` に entry を追記。スクリプトは `plugins/<name>/hooks/scripts/`

いずれの場合も plugin.json の `version` を MINOR bump する (必須)。

## 更新ワークフロー (既存要素の修正)

既存の skill / agent / command / hook / manifest の中身を修正するとき:

1. 対象要素を修正する
2. plugin.json の `version` を PATCH bump する (必須、ただし trivial 変更は省略可。後述の「バージョンルール」を参照)
3. `marketplace.json` 側の `description` 等を触ったときのみ marketplace.json も同時に修正する (plugin.json 側の変更だけなら marketplace.json は触らない)

## 削除ワークフロー

### skill 単体を削除する

- `plugins/<name>/skills/<skill>/` ディレクトリを削除
- plugin.json の `version` を MINOR bump

### プラグインを丸ごと削除する

- `plugins/<name>/` ディレクトリを削除
- `.claude-plugin/marketplace.json` の `plugins[]` から該当エントリを削除
- 同 marketplace.json の `renames` フィールドに `{"<name>": null}` を追記して、既存ユーザの migration を担保する

renames の例:

```json
{
  "name": "nakt-tools",
  "plugins": [ ... ],
  "renames": {
    "old-plugin-name": null
  }
}
```

## バージョンルール (bump は必須)

- plugin.json の `version` は SemVer (MAJOR.MINOR.PATCH)
- 0.x 期は MINOR / PATCH のみ運用する。1.0 リリースで MAJOR 解禁
- MINOR bump の対象: 新 skill / agent / command / hook / MCP server の追加、既存要素の削除、非互換な仕様変更
- PATCH bump の対象: 既存要素の意味を変える小修正 (文言の意味変更、微改良、コマンド / オプション追加など)
- trivial 変更 (typo 修正、リンク切れ修正、コメント整形など、install 側の使用感に影響しない修正) は bump 省略可
- marketplace.json の plugin エントリには `version` を書かない (plugin.json 側に一元化する。公式仕様上、plugin.json 側の `version` が marketplace エントリの `version` より優先される)

`version` の文字列が変わらない限り、install ユーザに更新は配布されない。「必要な変更をしたのに bump 忘れ」は install ユーザ側で気付けないので、変更したら必ず bump する (trivial 変更は例外)。

## 開発支援

Anthropic 公式の `plugin-dev` バンドルを利用する。以下の 7 skill が含まれる:

- skill-development
- agent-development
- command-development
- hook-development
- mcp-integration
- plugin-structure
- plugin-settings

参照とインストール:

- 参照: <https://github.com/anthropics/claude-plugins-official/tree/main/plugins/plugin-dev>
- インストールは Claude Code の `/plugin` コマンドから

この repo では `plugin-dev` と重複する開発支援 skill を独自定義しない (公式更新との乖離を避けるため)。

## Key Principles

1. 1 リポジトリ = 1 マーケットプレイス (`nakt-tools`)。プラグインは機能単位で独立した install / uninstall の粒度
2. プラグイン同士は独立させる。他プラグインへの依存や相互参照を持ち込まない
3. 命名はすべて kebab-case、`SKILL.md` や `hooks.json` などのファイル名は公式規約に従う
4. プラグイン内のファイル参照は `${CLAUDE_PLUGIN_ROOT}` を使う
5. 何かを変更したら plugin.json の `version` を必ず bump する (trivial 変更は例外)
6. 独自の慣例を追加しない。ディレクトリ規約・マニフェスト形式は Claude Code 公式仕様に従う
