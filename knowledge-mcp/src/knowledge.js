// 共通知識MDの安全保存（Make「Safe Update Shared Knowledge」8027652 の置き換え）。
// 処理順：入力検査 → 対象検査 → 再送判定 → 版の照合 → 本文取得・差分適用 → 書込み直前の再確認
//        → 更新前コピー → 本文更新 → 保存後の全文照合 → 依頼記録 → バックアップ20世代整理 → 結果返却
// Drive の操作は drive オブジェクト（src/drive.js）経由で行い、テストでは偽物に差し替える。

export const KEEP_GENERATIONS = 20;
const MODES = ['full', 'append', 'replace_exact'];
const BACKUP_SUFFIX = /-backup-[0-9]{8}-[0-9]{6}-[0-9]{3}[.]md$/;
const META_FIELDS = 'id,name,mimeType,parents,trashed,version,modifiedTime,appProperties';

// appProperties のキー（値は SHA-256 の16進。依頼IDの生値や本文は保存しない）
const P = {
  request: 'kmReq',
  input: 'kmIn',
  mode: 'kmMode',
  base: 'kmBase',
  after: 'kmAfter',
  backup: 'kmBackup',
};

export async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Asia/Tokyo（UTC+9、夏時間なし）で YYYYMMDD-HHmmss-SSS
export function tokyoStamp(date = new Date()) {
  const iso = new Date(date.getTime() + 9 * 3600 * 1000).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}-${iso.slice(20, 23)}`;
}

function sameTime(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && ta === tb;
}

function countOccurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function escapeQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// 更新・読み取りの対象は AI-Knowledge 直下・text/markdown・末尾 .md・ゴミ箱以外の既存ファイルだけ
export function checkTarget(meta, config) {
  if (!meta || meta.trashed) return 'ゴミ箱内のファイルは対象外です';
  if (!(meta.parents || []).includes(config.knowledgeFolderId)) return 'AI-Knowledge直下のファイルではありません';
  if (meta.mimeType !== 'text/markdown') return 'text/markdownではありません';
  if (!meta.name || !meta.name.endsWith('.md')) return 'ファイル名が.mdで終わっていません';
  return null;
}

function result(status, fields = {}) {
  return {
    status,
    file_id: fields.file_id ?? null,
    match: fields.match ?? false,
    length: fields.length ?? null,
    backup_file_id: fields.backup_file_id ?? null,
    modified_time: fields.modified_time ?? null,
    ...(fields.message ? { message: fields.message } : {}),
  };
}

function validateInput(input) {
  const { file_id, expected_modified_time, request_id, mode, content, old_text } = input || {};
  if (typeof file_id !== 'string' || !file_id) return 'file_idが必要です';
  if (typeof expected_modified_time !== 'string' || !Number.isFinite(Date.parse(expected_modified_time))) {
    return 'expected_modified_timeが必要です（取得したmodifiedTimeをそのまま渡す）';
  }
  if (typeof request_id !== 'string' || !request_id) return 'request_idが必要です';
  if (!MODES.includes(mode)) return `modeは${MODES.join(' / ')}のいずれかです`;
  if (typeof content !== 'string') return 'contentが必要です';
  if (mode !== 'replace_exact' && content === '') return '空のcontentは受け付けません';
  if (mode === 'replace_exact' && (typeof old_text !== 'string' || old_text === '')) {
    return 'replace_exactには空でないold_textが必要です';
  }
  return null;
}

function applyChange(current, { mode, content, old_text }) {
  if (mode === 'full') return { text: content };
  if (mode === 'append') return { text: current + content };
  const count = countOccurrences(current, old_text);
  if (count !== 1) return { error: `old_textの一致が${count}件です（ちょうど1件が必要）` };
  const index = current.indexOf(old_text);
  return { text: current.slice(0, index) + content + current.slice(index + old_text.length) };
}

export async function safeUpdate(drive, config, input, now = () => new Date()) {
  const invalid = validateInput(input);
  if (invalid) return result('invalid_request', { file_id: input?.file_id, message: invalid });

  const { file_id, expected_modified_time, request_id, mode, content } = input;
  const oldText = mode === 'replace_exact' ? input.old_text : '';

  // 1. 対象の検査
  const meta = await drive.getMeta(file_id, META_FIELDS);
  const targetError = checkTarget(meta, config);
  if (targetError) return result('invalid_request', { file_id, message: targetError });

  // 2. 再送判定：直近の依頼と依頼ID・全入力・保存後本文が一致すれば書き直さない
  const requestHash = await sha256(request_id);
  const inputHash = await sha256(JSON.stringify([mode, expected_modified_time, content, oldText]));
  const props = meta.appProperties || {};
  if (props[P.request] === requestHash) {
    if (props[P.input] !== inputHash) {
      return result('invalid_request', { file_id, message: '同じrequest_idが別の入力で使われています' });
    }
    const body = await drive.download(file_id);
    if ((await sha256(body)) === props[P.after]) {
      return result('already_applied', {
        file_id,
        match: true,
        length: body.length,
        backup_file_id: props[P.backup] || null,
        modified_time: meta.modifiedTime,
      });
    }
  }

  // 3. 版の照合
  if (!sameTime(meta.modifiedTime, expected_modified_time)) {
    return result('conflict', {
      file_id,
      modified_time: meta.modifiedTime,
      message: '本文が更新されています。最新版を取得して統合し直し、新しいrequest_idで保存してください',
    });
  }

  // 4. 本文取得と差分適用
  const current = await drive.download(file_id);
  const change = applyChange(current, { mode, content, old_text: oldText });
  if (change.error) return result('invalid_request', { file_id, message: change.error });
  if (change.text === '') return result('invalid_request', { file_id, message: '更新後の本文が空になります' });

  // 5. 書込み直前の再確認（modifiedTime と version）
  const recheck = await drive.getMeta(file_id, 'id,version,modifiedTime');
  if (recheck.modifiedTime !== meta.modifiedTime || recheck.version !== meta.version) {
    return result('conflict', {
      file_id,
      modified_time: recheck.modifiedTime,
      message: '処理中に本文が更新されました。最新版を取得して統合し直してください',
    });
  }

  // 6. 更新前コピー → 本文更新 → 保存後の全文照合
  const backup = await drive.copy(file_id, `${meta.name}-backup-${tokyoStamp(now())}.md`, config.backupFolderId);
  const updated = await drive.uploadContent(file_id, change.text);
  const saved = await drive.download(file_id);
  if (saved !== change.text) {
    return result('verification_failed', {
      file_id,
      match: false,
      length: saved.length,
      backup_file_id: backup.id,
      modified_time: updated.modifiedTime,
      message: '保存後の本文が一致しません。本文は書き込まれている可能性があります',
    });
  }

  // 7. 依頼記録（全文照合の後に書く）
  const recorded = await drive.setAppProperties(file_id, {
    [P.request]: requestHash,
    [P.input]: inputHash,
    [P.mode]: mode,
    [P.base]: meta.modifiedTime,
    [P.after]: await sha256(saved),
    [P.backup]: backup.id,
  });

  // 8. バックアップ20世代整理（失敗しても本文は保存済み）
  let cleanupError = null;
  try {
    await pruneBackups(drive, config, meta.name);
  } catch (error) {
    cleanupError = `バックアップ整理でエラー：${error.message}`;
  }

  return result('saved', {
    file_id,
    match: true,
    length: saved.length,
    backup_file_id: backup.id,
    modified_time: recorded.modifiedTime,
    message: cleanupError,
  });
}

// 同じ元ファイル名の正規バックアップを作成日時の新しい順に20世代残し、21世代目以降をゴミ箱へ移す（完全削除しない）
export async function pruneBackups(drive, config, name) {
  const q = [
    `'${escapeQuery(config.backupFolderId)}' in parents`,
    'trashed = false',
    "mimeType = 'text/markdown'",
    `name contains '${escapeQuery(`${name}-backup-`)}'`,
  ].join(' and ');
  const listed = await drive.list(q);
  // 次ページがある場合は安全のため整理しない
  if (listed.nextPageToken) return { trashed: [], skipped: true };
  const backups = (listed.files || [])
    .filter((file) => BACKUP_SUFFIX.test(file.name) && file.name.replace(BACKUP_SUFFIX, '') === name)
    .sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime));
  const trashed = [];
  for (const file of backups.slice(KEEP_GENERATIONS)) {
    await drive.trash(file.id);
    trashed.push(file.id);
  }
  return { trashed, skipped: false };
}

export async function readKnowledge(drive, config, input) {
  const fileId = input?.file_id;
  if (typeof fileId !== 'string' || !fileId) return { status: 'invalid_request', message: 'file_idが必要です' };
  const meta = await drive.getMeta(fileId, META_FIELDS);
  const targetError = checkTarget(meta, config);
  if (targetError) return { status: 'invalid_request', file_id: fileId, message: targetError };
  const content = await drive.download(fileId);
  return {
    status: 'ok',
    file_id: fileId,
    name: meta.name,
    modified_time: meta.modifiedTime,
    length: content.length,
    content,
  };
}

export async function listKnowledge(drive, config) {
  const q = [
    `'${escapeQuery(config.knowledgeFolderId)}' in parents`,
    'trashed = false',
    "mimeType = 'text/markdown'",
  ].join(' and ');
  const listed = await drive.list(q, 'name');
  return {
    status: 'ok',
    files: (listed.files || [])
      .filter((file) => file.name.endsWith('.md'))
      .map((file) => ({ file_id: file.id, name: file.name, modified_time: file.modifiedTime })),
  };
}
