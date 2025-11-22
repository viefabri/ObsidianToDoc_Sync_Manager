# D_GAS_NotebookLM_Sync_Design.md

# System Design: NotebookLM Sync Manager

## 1. 概要 (Overview)
本システムは、Obsidianのローカルナレッジ（Markdownファイル）を、Google NotebookLMが参照可能なGoogleドキュメント形式に変換・同期するためのGASツールである。
ユーザーの手作業（トイル）を排除し、指定したフォルダ構成に従って自動的に同期を行う。また、初期構築の手間を省くための自動セットアップ機能を備える。

## 2. アーキテクチャ (Architecture)
- **Platform**: Google Apps Script (GAS) - Standalone Script
- **Database**: Google Spreadsheet (構成管理および実行ログ)
- **File Storage**: Google Drive (Source: Markdown / Target: Google Docs)

## 3. データベース設計 (Spreadsheet)
**自動生成**: 本スプレッドシートは、スクリプトの初回実行時に自動生成される。

### Sheet 1: `Settings` (構成設定)
同期元と同期先のペアを管理する。
| Column Name | Type | Description |
| :--- | :--- | :--- |
| **Memo** | String | プロジェクト名や用途のメモ（例: "マンダム案件"） |
| **Source_Folder_URL** | String | Obsidianデータの格納されているGoogleドライブフォルダURL |
| **Target_Folder_URL** | String | 変換後のGoogleドキュメントを出力するフォルダURL |
| **Recursive?** | Boolean | サブフォルダもスキャン対象とするか (TRUE: 再帰 / FALSE: 直下のみ) |

### Sheet 2: `Console` (実行管理DB)
個々のファイルの同期状態を管理する。GASにより自動更新される。
| Column Name | Description |
| :--- | :--- |
| **Sync?** | 【重要】ユーザー操作列。TRUEの行のみ同期処理を行う。スキャン時に既存の値は維持される。 |
| **Project** | `Settings` シートのMemoを転記。 |
| **File_Name** | Markdownファイル名（拡張子含む）。 |
| **Folder_Path** | 親フォルダまでのパス（同名ファイル判別用）。 |
| **MD_ID** | 【Key】MarkdownファイルのドライブID。 |
| **Doc_ID** | 紐づくGoogleドキュメントのID。 |
| **Last_Updated_MD** | Markdownファイルの最終更新日時。 |
| **Last_Sync_Time** | Googleドキュメントへの最終同期日時。 |
| **Status** | 実行結果ログ（"Synced", "Skipped", "Missing", "Error" 等）。 |

## 4. 機能要件 (Functional Requirements)

### A. 初期セットアップ機能 (`setupSystem`)
ユーザーが手動でスプレッドシートを作成する手間を排除する。
1. **シート作成**: 新規スプレッドシート「NotebookLM_Sync_DB」を作成する。
2. **構造定義**: `Settings` シートと `Console` シートを作成し、それぞれ指定のヘッダー行を書き込む。
3. **ID保存**: 作成したスプレッドシートのIDを `PropertiesService.getScriptProperties()` にキー `SPREADSHEET_ID` として保存する。
    - ※以降の関数（scan/sync）は、このプロパティからIDを参照する（ハードコーディング回避）。
4. **ログ出力**: 作成されたシートのURLをログに出力する。

### B. スキャン機能 (`scanTargetFolder`)
ユーザーが「リスト更新」を実行した際の挙動。
1. **設定読み込み**: プロパティからシートIDを取得し、`Settings` シートの全行を読み込む。
2. **ファイル探索**:
    - 各行の設定に基づき、`Source_Folder_URL` 内の `.md` ファイルを取得する。
    - `Recursive?` が TRUE の場合は、サブフォルダ内のファイルも全て取得する（再帰処理）。
3. **リストのマージ (State Preservation)**:
    - `Console` シートの既存データを読み込み、`MD_ID` をキーとして照合する。
    - **既存ファイル**: ユーザーが設定した `Sync?` チェックボックスの状態は**絶対に維持する**。`Doc_ID` も維持する。ファイル名が変更されていた場合は更新する。
    - **新規ファイル**: 新しい行を追加する。`Sync?` の初期値は `FALSE` とする。
    - **削除ファイル**: ドライブ上に存在しないファイルは、ステータスを "Missing" とする。

### C. 同期機能 (`syncFiles`)
ユーザーが「同期実行」を実行した際の挙動。
1. **対象抽出**: `Console` シートで `Sync?` が `TRUE` の行を対象とする。
2. **差分判定**: `Last_Updated_MD` > `Last_Sync_Time` のファイルのみ処理する（APIクォータ節約）。
3. **ドキュメント処理**:
    - **命名規則**: Markdownファイル名をそのまま使用する（パスなどのプレフィックスは付与しない）。
    - **新規作成**: `Doc_ID` が空、または無効（404エラー）の場合、`Target_Folder` に新規ドキュメントを作成する。
    - **更新**: 既存のドキュメントに対し、Markdownの本文テキストを上書き (`setText`) する。
    - **リネーム**: Doc名と現在のMD名が異なる場合、Doc名をMD名に合わせて変更する。
4. **完了処理**: `Last_Sync_Time` と `Status` を更新する。

### D. UI要件
- スプレッドシートのメニューバーではなく、スクリプトエディタからの実行、あるいは将来的な拡張を見越して `onOpen` トリガーを設定する（ただしStandaloneのため初回は手動実行前提）。
- メニュー項目:
    1. 「⚙️ 初回セットアップ」 -> `setupSystem`
    2. 「📂 リスト更新 (設定維持)」 -> `scanTargetFolder`
    3. 「🔄 同期実行 (差分のみ)」 -> `syncFiles`

## 5. エラーハンドリング
- ファイルアクセス権限エラーや、同期先ドキュメントが手動で削除されていた場合でも、スクリプト全体を停止せず、該当行の `Status` にエラー内容を記録して次の処理へ進むこと（`try...catch` の徹底）。