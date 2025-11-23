/**
 * NotebookLM Sync Manager
 * 
 * ObsidianのMarkdownファイルをGoogleドキュメントに同期し、NotebookLMでの利用を支援するスクリプト。
 * 
 * @author 後藤 柳次郎
 * @version 1.0.0
 */

/**
 * プロパティキー定数
 */
const PROP_KEY_SS_ID = 'SPREADSHEET_ID';

/**
 * ターゲットフォルダID (DB格納先)
 */
const DB_TARGET_FOLDER_ID = '1OmUPY7_UV-WJezHrrXfySknvC-jLFnaW';

/**
 * メニューを作成する関数
 * スタンドアロンスクリプトのため、初回は手動で実行するか、トリガー設定後に有効になります。
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  // スタンドアロンの場合はSpreadsheetApp.getUi()がコンテナバインドされていないと機能しない場合があるが、
  // スプレッドシートから開かれた場合を想定してメニューを追加。
  // ※スクリプトエディタから直接実行する場合は関数を選択して実行してください。
  try {
    ui.createMenu('NotebookLM Sync')
      .addItem('⚙️ 初回セットアップ', 'setupSystem')
      .addItem('📂 リスト更新 (設定維持)', 'scanTargetFolder')
      .addItem('🔄 同期実行 (差分のみ)', 'syncFiles')
      .addSeparator()
      .addItem('🔧 ファイル名修正 (リカバリ)', 'fixFilenames')
      .addToUi();
  } catch (e) {
    console.warn('onOpen: UI操作はコンテナバインドスクリプト、またはスプレッドシートが開かれている状態でのみ有効です。', e);
  }
}

/**
 * システムの初期セットアップを行う関数
 * 1. 新規スプレッドシート「NotebookLM_Sync_DB」を作成
 * 2. 指定フォルダへ移動
 * 3. 必要なシートとヘッダーを作成
 * 4. スプレッドシートIDをスクリプトプロパティに保存
 */
function setupSystem() {
  console.log('セットアップを開始します...');

  try {
    // 1. スプレッドシート作成
    const ssName = 'NotebookLM_Sync_DB';
    const ss = SpreadsheetApp.create(ssName);
    const ssId = ss.getId();
    console.log(`スプレッドシートを作成しました: ${ss.getUrl()}`);

    // 2. 指定フォルダへ移動
    const file = DriveApp.getFileById(ssId);
    const targetFolder = DriveApp.getFolderById(DB_TARGET_FOLDER_ID);
    file.moveTo(targetFolder);
    console.log(`スプレッドシートを指定フォルダ(${DB_TARGET_FOLDER_ID})へ移動しました。`);

    // 3. シート構成の作成
    // Settingsシート
    let settingsSheet = ss.getSheetByName('Settings');
    if (!settingsSheet) {
      settingsSheet = ss.insertSheet('Settings');
      // デフォルトの「シート1」があれば削除（ただしシートが1つしか無いと削除できないので後で）
    }
    const settingsHeader = ['Memo', 'Source_Folder_URL', 'Target_Folder_URL', 'Recursive?'];
    settingsSheet.getRange(1, 1, 1, settingsHeader.length).setValues([settingsHeader]);
    settingsSheet.setFrozenRows(1);

    // Consoleシート
    let consoleSheet = ss.getSheetByName('Console');
    if (!consoleSheet) {
      consoleSheet = ss.insertSheet('Console');
    }
    const consoleHeader = ['Sync?', 'Project', 'File_Name', 'Folder_Path', 'MD_ID', 'Doc_ID', 'Last_Updated_MD', 'Last_Sync_Time', 'Status'];
    consoleSheet.getRange(1, 1, 1, consoleHeader.length).setValues([consoleHeader]);
    consoleSheet.setFrozenRows(1);

    // チェックボックスの入力規則を設定 (Sync?列)
    const rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
    consoleSheet.getRange('A2:A1000').setDataValidation(rule); // 一旦1000行まで

    // 不要なデフォルトシート削除
    const sheet1 = ss.getSheetByName('シート1');
    if (sheet1) ss.deleteSheet(sheet1);

    // 4. ID保存
    PropertiesService.getScriptProperties().setProperty(PROP_KEY_SS_ID, ssId);
    console.log(`スクリプトプロパティにIDを保存しました: ${ssId}`);

    console.log('セットアップ完了。');

  } catch (e) {
    console.error('セットアップ中にエラーが発生しました:', e);
    throw e;
  }
}

/**
 * ターゲットフォルダをスキャンし、Consoleシートを更新する関数
 * Settingsシートの設定に基づいてMarkdownファイルを探索します。
 */
function scanTargetFolder() {
  const ss = getSpreadsheet_();
  if (!ss) return;

  const settingsSheet = ss.getSheetByName('Settings');
  const consoleSheet = ss.getSheetByName('Console');

  // 設定読み込み
  const settingsData = settingsSheet.getDataRange().getValues();
  settingsData.shift(); // ヘッダー削除

  // 既存データ読み込み (状態維持のため)
  const consoleData = consoleSheet.getDataRange().getValues();
  const consoleHeader = consoleData.shift(); // ヘッダー削除

  // MD_IDをキーにしたマップを作成
  const existingFilesMap = new Map();
  consoleData.forEach(row => {
    const mdId = row[4]; // MD_ID index
    if (mdId) {
      existingFilesMap.set(mdId, {
        sync: row[0],
        docId: row[5],
        lastSyncTime: row[7],
        row: row
      });
    }
  });

  let newConsoleData = [];

  console.log('スキャンを開始します...');

  settingsData.forEach(setting => {
    const [memo, sourceUrl, targetUrl, recursive] = setting;
    if (!sourceUrl) return;

    try {
      const sourceFolderId = getIdFromUrl_(sourceUrl);
      const sourceFolder = DriveApp.getFolderById(sourceFolderId);

      const files = [];
      processFolder_(sourceFolder, files, recursive, "");

      files.forEach(file => {
        const mdId = file.getId();
        const fileName = file.getName();
        const lastUpdated = file.getLastUpdated();

        let sync = false;
        let docId = '';
        let lastSyncTime = '';
        let status = '';

        // 既存データの維持
        if (existingFilesMap.has(mdId)) {
          const existing = existingFilesMap.get(mdId);
          sync = existing.sync;
          docId = existing.docId;
          lastSyncTime = existing.lastSyncTime;
          status = 'Scanned'; // ステータスは更新
          existingFilesMap.delete(mdId); // 処理済みとして削除
        } else {
          status = 'New';
        }

        newConsoleData.push([
          sync,
          memo,
          fileName,
          file.folderPath, // processFolder_で設定
          mdId,
          docId,
          lastUpdated,
          lastSyncTime,
          status
        ]);
      });

    } catch (e) {
      console.error(`フォルダ処理エラー (${memo}):`, e);
      // エラーログを行に追加するなどの処理も考えられるが、今回はログ出力のみ
    }
  });

  // 削除されたファイル（existingFilesMapに残っているもの）の処理
  existingFilesMap.forEach((val, key) => {
    const row = val.row;
    row[8] = 'Missing'; // Status更新
    newConsoleData.push(row);
  });

  // シート更新
  if (newConsoleData.length > 0) {
    // データ書き込み前にクリア（ヘッダー以外）
    if (consoleSheet.getLastRow() > 1) {
      consoleSheet.getRange(2, 1, consoleSheet.getLastRow() - 1, consoleSheet.getLastColumn()).clearContent();
    }
    consoleSheet.getRange(2, 1, newConsoleData.length, newConsoleData[0].length).setValues(newConsoleData);
  }

  console.log('スキャン完了。');
}

/**
 * 同期を実行する関数
 * Consoleシートを確認し、同期対象かつ更新が必要なファイルを処理します。
 */
function syncFiles() {
  const ss = getSpreadsheet_();
  if (!ss) return;

  const settingsSheet = ss.getSheetByName('Settings');
  const consoleSheet = ss.getSheetByName('Console');

  // SettingsからTarget Folder URLを取得するためのマップ
  const settingsData = settingsSheet.getDataRange().getValues();
  settingsData.shift();
  const projectTargetMap = new Map();
  settingsData.forEach(row => {
    projectTargetMap.set(row[0], row[2]); // Memo -> Target_Folder_URL
  });

  const dataRange = consoleSheet.getDataRange();
  const data = dataRange.getValues();
  const header = data.shift(); // ヘッダー

  // 列インデックス
  const IDX_SYNC = 0;
  const IDX_PROJECT = 1;
  const IDX_FILENAME = 2;
  const IDX_MD_ID = 4;
  const IDX_DOC_ID = 5;
  const IDX_LAST_UPDATED = 6;
  const IDX_LAST_SYNC = 7;
  const IDX_STATUS = 8;

  const now = new Date();
  let updatedCount = 0;

  console.log('同期処理を開始します...');

  // 行ごとに処理
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const sync = row[IDX_SYNC];

    if (!sync) continue; // 同期対象外

    const mdId = row[IDX_MD_ID];
    const lastUpdated = new Date(row[IDX_LAST_UPDATED]);
    const lastSync = row[IDX_LAST_SYNC] ? new Date(row[IDX_LAST_SYNC]) : new Date(0);

    // 更新判定: MD更新日時 > 最終同期日時
    if (lastUpdated <= lastSync) {
      // 既に同期済み
      continue;
    }

    try {
      const mdFile = DriveApp.getFileById(mdId);
      const mdContent = mdFile.getBlob().getDataAsString();
      const project = row[IDX_PROJECT];
      const targetUrl = projectTargetMap.get(project);

      if (!targetUrl) {
        row[IDX_STATUS] = 'Error: No Target URL';
        continue;
      }

      const targetFolderId = getIdFromUrl_(targetUrl);
      const targetFolder = DriveApp.getFolderById(targetFolderId);

      let docId = row[IDX_DOC_ID];
      let doc;

      // ドキュメント取得または作成
      if (docId) {
        try {
          doc = DocumentApp.openById(docId);
          // リネームチェック
          const docName = row[IDX_FILENAME].replace(/\.md$/i, '');
          if (doc.getName() !== docName) {
            doc.setName(docName);
          }
        } catch (e) {
          // 開けない場合は新規作成扱い
          console.warn(`既存ドキュメントが開けません (ID: ${docId})。新規作成します。`);
          doc = null;
        }
      }

      if (!doc) {
        // 新規作成
        const docName = row[IDX_FILENAME].replace(/\.md$/i, '');
        doc = DocumentApp.create(docName);
        const docFile = DriveApp.getFileById(doc.getId());
        docFile.moveTo(targetFolder); // 指定フォルダへ移動
        docId = doc.getId();
        row[IDX_DOC_ID] = docId; // ID更新
      }

      // 内容更新 (全置換)
      const body = doc.getBody();
      body.clear();
      body.setText(mdContent);
      doc.saveAndClose();

      // ステータス更新
      row[IDX_LAST_SYNC] = now;
      row[IDX_STATUS] = 'Synced';
      updatedCount++;
      console.log(`同期完了: ${row[IDX_FILENAME]}`);

    } catch (e) {
      console.error(`同期エラー (${row[IDX_FILENAME]}):`, e);
      row[IDX_STATUS] = `Error: ${e.message}`;
    }

    // 配列に行を戻す
    data[i] = row;
  }

  // 結果をシートに書き戻し
  if (updatedCount > 0 || data.length > 0) {
    consoleSheet.getRange(2, 1, data.length, data[0].length).setValues(data);
  }

  console.log(`同期処理終了。更新数: ${updatedCount}`);
}

/**
 * 既存のGoogleドキュメントの名前から拡張子(.md)を除去するリカバリ用関数
 * 既に同期済みのファイルに対しても名前の修正を適用します。
 */
function fixFilenames() {
  const ss = getSpreadsheet_();
  if (!ss) return;

  const consoleSheet = ss.getSheetByName('Console');
  const dataRange = consoleSheet.getDataRange();
  const data = dataRange.getValues();
  data.shift(); // ヘッダー削除

  // 列インデックス (syncFilesと同じ)
  const IDX_FILENAME = 2;
  const IDX_DOC_ID = 5;

  let fixedCount = 0;
  console.log('ファイル名修正処理を開始します...');

  data.forEach(row => {
    const fileName = row[IDX_FILENAME];
    const docId = row[IDX_DOC_ID];

    if (docId) {
      try {
        const doc = DocumentApp.openById(docId);
        const currentDocName = doc.getName();
        const correctName = fileName.replace(/\.md$/i, '');

        if (currentDocName !== correctName) {
          doc.setName(correctName);
          console.log(`修正しました: "${currentDocName}" -> "${correctName}"`);
          fixedCount++;
        }
      } catch (e) {
        console.warn(`ドキュメントへのアクセスエラー (${fileName}):`, e.message);
      }
    }
  });

  console.log(`ファイル名修正完了。修正数: ${fixedCount}`);
}

// --- Helper Functions ---

/**
 * 保存されたIDからスプレッドシートを取得する
 * @return {Spreadsheet} スプレッドシートオブジェクト
 */
function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP_KEY_SS_ID);
  if (!id) {
    console.error('スプレッドシートIDが設定されていません。setupSystemを実行してください。');
    return null;
  }
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    console.error('スプレッドシートを開けませんでした:', e);
    return null;
  }
}

/**
 * URLからIDを抽出する
 * @param {string} url 
 * @return {string} ID
 */
function getIdFromUrl_(url) {
  const match = url.match(/[-\w]{25,}/);
  return match ? match[0] : url;
}

/**
 * フォルダを再帰的にスキャンしてファイルを収集する
 * @param {Folder} folder 対象フォルダ
 * @param {Array} filesList 結果格納用配列
 * @param {boolean} recursive 再帰するかどうか
 * @param {string} pathPrefix パスプレフィックス
 */
function processFolder_(folder, filesList, recursive, pathPrefix) {
  const files = folder.getFilesByType(MimeType.PLAIN_TEXT); // .mdは通常PLAIN_TEXTとして扱われることが多いが、拡張子チェックも行う
  // DriveAppではMimeTypeで完全に絞りきれない場合があるため、全ファイル取得して拡張子フィルタの方が確実な場合もあるが、
  // ここでは効率のため一旦PLAIN_TEXT等で取得しつつ、拡張子を確認する。
  // ※MarkdownのMimeTypeは環境により異なる場合がある。

  // 念のため全ファイルイテレータから拡張子でフィルタリングする方式を採用（確実性重視）
  const allFiles = folder.getFiles();
  while (allFiles.hasNext()) {
    const file = allFiles.next();
    if (file.getName().endsWith('.md')) {
      // fileオブジェクトにカスタムプロパティとしてパスを持たせる（JSオブジェクトなので可能）
      file.folderPath = pathPrefix + folder.getName();
      filesList.push(file);
    }
  }

  if (recursive) {
    const subFolders = folder.getFolders();
    while (subFolders.hasNext()) {
      const subFolder = subFolders.next();
      processFolder_(subFolder, filesList, recursive, pathPrefix + folder.getName() + "/");
    }
  }
}
