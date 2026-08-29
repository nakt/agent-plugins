# typescript-native-lsp

TypeScript 7 のネイティブ LSP を Claude Code に接続するプラグイン。

## 背景

TypeScript 7 (2026-07-08 GA) は Go によるネイティブ実装で、従来の `tsserver.js` を出荷しない。公式の `typescript-lsp` プラグインは `typescript-language-server` を起動するが、これは `tsserver.js` のラッパーなので、TypeScript 7 のプロジェクトでは初期化に失敗する。

```text
Could not find a valid TypeScript installation. Please ensure that the "typescript"
dependency is installed in the workspace or that a valid `tsserver.path` is specified.
```

TypeScript 7 は代わりに標準 LSP を直接話すため、`tsc --lsp --stdio` をそのまま language server として使える。このプラグインはその接続だけを行う。

公式プラグイン側の対応要望は [anthropics/claude-plugins-official#4492](https://github.com/anthropics/claude-plugins-official/issues/4492) にある。そちらが解決したらこのプラグインは役目を終える。

## 前提

TypeScript 7 以上が PATH から `tsc` として使えること。

```shell
brew install typescript   # または npm install -g typescript
tsc --version             # Version 7.0.0 以上
```

## 使い方

公式の `typescript-lsp` と同じ拡張子を扱うため、併用できない。公式プラグインを無効化してからインストールする。

```shell
/plugin disable typescript-lsp@claude-plugins-official
/plugin install typescript-native-lsp@nakt-tools
```

プラグインの有効・無効はセッション起動時に読み込まれるので、切り替えた後は Claude Code を再起動する。

## 公式プラグインとの違い

`typescript-language-server` はワークスペースの `node_modules` から TypeScript を探すため、セッションの作業ディレクトリに `node_modules` が無いと動かない。`tsc --lsp` にはその制約が無く、作業ディレクトリの外にあるファイルも解析できる。

## 既知の制限

TypeScript 5 系のプロジェクトを解析する場合、型チェックが TypeScript 7 の基準で行われるため、プロジェクト自身の `tsc --noEmit` と診断が食い違うことがある。実測した例として、Next.js プロジェクトの CSS の副作用インポートで TypeScript 7 だけがエラーを出す。

```text
error TS2882: Cannot find module or type declarations for side-effect import of './globals.css'
```

定義ジャンプ・参照検索・シンボル一覧・ホバーの型情報は TypeScript 5 系のプロジェクトでも正しく動作する (パスエイリアス、`node_modules` 配下の型定義への解決を含む)。型の正しさはプロジェクト自身の `tsc --noEmit` が担保するという前提で使う。

診断そのものが不要なら `.lsp.json` に `"diagnostics": false` を足す。
