# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## リポジトリの目的

個人利用を主目的とした Claude Code (claude.ai/code) 向けプラグインの置き場所。マーケットプレイス名は `nakt-tools`。

## 設計思想

- 1 リポジトリ = 1 マーケットプレイス。マーケットプレイス配下に、機能単位で独立したプラグインを並置する
- プラグイン同士は独立させる (skill / agent / hook / command の相互参照や他プラグインへの依存を持ち込まない)
- ディレクトリ規約・マニフェスト形式は Claude Code 公式仕様に従う。独自の慣例を追加しない

## 開発ルール

プラグインの追加・機能追加・更新・削除の作法、命名規約、ディレクトリ構成、`plugin.json` の version bump ルールは `.claude/skills/plugin-authoring/` に集約している。ユーザーの発話に応じて Claude Code が自動起動する。

## 公式リファレンス

プラグイン開発の一次情報:

- プラグイン開発ガイド: <https://code.claude.com/docs/en/plugins>
- プラグイン技術仕様 (`plugin.json` / ディレクトリ構造 / バージョニング): <https://code.claude.com/docs/en/plugins-reference>
- マーケットプレイスの作成と配布: <https://code.claude.com/docs/en/plugin-marketplaces>
- Skills / Subagents / Hooks / MCP: <https://code.claude.com/docs/en/skills>, <https://code.claude.com/docs/en/sub-agents>, <https://code.claude.com/docs/en/hooks>, <https://code.claude.com/docs/en/mcp>
