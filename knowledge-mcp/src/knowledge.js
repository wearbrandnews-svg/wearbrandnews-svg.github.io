// 共通知識MDの安全保存（Make「Safe Update Shared Knowledge」8027652 の置き換え）。
// 処理順：入力検査 → 対象検査 → 再送判定 → 版の照合 → 本文取得・差分適用 → 書込み直前の再確認
//        → 更新前コピー → 本文更新 → 保存後の全文照合 → 依頼記録 → バックアップ20世代整理 → 結果返却
// Drive の操作は drive オブジェクト（src/drive.js）経由で行い、テストでは偽物に差し替える。

import { inspectMarkdown, inspectKnowledge, selectMarkdown } from './markdown.js';
import { searchMarkdown, routeFiles } from './search.js';
import { newSecretKinds, findSecrets } from './secrets.js';

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

  // Reject newly introduced structural defects without blocking repairs of old ones.
  const issueKey = issue => JSON.stringify([issue.code, issue.id || '', issue.message]);
  const oldIssues = new Set(inspectMarkdown(current).issues.map(issueKey));
  const newIssues = inspectMarkdown(change.text).issues.filter(issue => !oldIssues.has(issueKey(issue)));
  if (newIssues.length) return result('invalid_request', { file_id, message: `構造の点検で問題：${newIssues.map(i => i.message).join(' / ')}` });
  const secrets = newSecretKinds(current, change.text);
  if (secrets.length) return result('invalid_request', { file_id, message: `秘密情報らしい文字列があるため保存しません（${secrets.join('、')}）。値を除いて保存し直してください` });

  // 6. Update body and retry markers in ONE Drive multipart request. If the
  // response or later verification is lost, an identical retry can recover.
  const backup = await drive.copy(file_id, `${meta.name}-backup-${tokyoStamp(now())}.md`, config.backupFolderId);
  const lastCheck = await drive.getMeta(file_id, 'id,version,modifiedTime');
  if (lastCheck.modifiedTime !== meta.modifiedTime || lastCheck.version !== meta.version) {
    return result('conflict', { file_id, backup_file_id: backup.id, modified_time: lastCheck.modifiedTime, message: 'バックアップ中に本文が更新されました。最新版を取得してください' });
  }
  const updated = await drive.uploadContent(file_id, change.text, {
    [P.request]: requestHash,
    [P.input]: inputHash,
    [P.mode]: mode,
    [P.base]: meta.modifiedTime,
    [P.after]: await sha256(change.text),
    [P.backup]: backup.id,
  });
  // Confirm a stable snapshot after upload. An upload response is not a stable
  // read snapshot: Drive versions can change even when the body is unchanged.
  // Check the current body and request markers between two metadata reads.
  let saved, verifiedMeta, verified = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const verifyBefore = await drive.getMeta(file_id, META_FIELDS);
    saved = await drive.download(file_id);
    verifiedMeta = await drive.getMeta(file_id, META_FIELDS);
    if (verifyBefore.version === verifiedMeta.version && verifyBefore.modifiedTime === verifiedMeta.modifiedTime && !checkTarget(verifiedMeta, config)) {
      verified = true;
      break;
    }
  }
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

  if (!verified || verifiedMeta.appProperties?.[P.request] !== requestHash || verifiedMeta.appProperties?.[P.input] !== inputHash) {
    return result('verification_failed', { file_id, backup_file_id: backup.id, modified_time: verifiedMeta.modifiedTime, message: '保存後に版または依頼記録が変わりました。本文を再確認してください' });
  }

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
    modified_time: verifiedMeta.modifiedTime,
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
  if (input.query !== undefined && (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200 || input.section !== undefined || input.product_ids !== undefined || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 8)))) return { status: 'invalid_request', file_id: fileId, message: 'queryは1〜200文字、limitは1〜8です。section・product_idsと併用できません' };
  let meta, content, stable = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    meta = await drive.getMeta(fileId, META_FIELDS);
    const targetError = checkTarget(meta, config);
    if (targetError) return { status: 'invalid_request', file_id: fileId, message: targetError };
    content = await drive.download(fileId);
    const after = await drive.getMeta(fileId, META_FIELDS);
    if (!checkTarget(after, config) && after.version === meta.version && after.modifiedTime === meta.modifiedTime) { stable = true; break; }
  }
  if (!stable) return { status: 'conflict', file_id: fileId, message: '読み取り中に変更が続いています。少し後に取得してください' };
  if (input.query !== undefined) {
    const matches = searchMarkdown(content, meta.name, input.query, input.limit ?? 5);
    const excerpt = matches.map(m => `## ${m.section}\n${m.source_notes ? m.source_notes + '\n' : ''}${m.text}`).join('\n\n');
    return { status: 'ok', file_id: fileId, name: meta.name, modified_time: meta.modifiedTime, complete: false, evidence_only: true, query: input.query, matches, content: excerpt, length: excerpt.length, total_length: content.length, message: matches.length ? '関連箇所の候補であり網羅的な一覧や検証済みの回答ではありません。全体を列挙する質問では見出しの内容も取得してください。保存前は選択なしで全文を取得してください' : '一致なし。情報が存在しないとは断定せず、見出しや全文で確認してください' };
  }
  const selected = selectMarkdown(content, input);
  if (selected.error) return { status: 'invalid_request', file_id: fileId, message: selected.error };
  return {
    status: 'ok',
    file_id: fileId,
    name: meta.name,
    modified_time: meta.modifiedTime,
    length: selected.content.length,
    total_length: content.length,
    complete: selected.complete,
    content: selected.content,
  };
}

export async function listKnowledge(drive, config) {
  const q = [
    `'${escapeQuery(config.knowledgeFolderId)}' in parents`,
    'trashed = false',
    "mimeType = 'text/markdown'",
  ].join(' and ');
  const files = [];
  let pageToken;
  do {
    const listed = await drive.list(q, 'name', pageToken);
    files.push(...(listed.files || []));
    pageToken = listed.nextPageToken;
  } while (pageToken);
  return {
    status: 'ok',
    files: files
      .filter((file) => file.name.endsWith('.md'))
      .map((file) => ({ file_id: file.id, name: file.name, modified_time: file.modifiedTime })),
  };
}

export async function checkKnowledge(drive, config) {
  const listed = await listKnowledge(drive, config);
  const files = [];
  for (const file of listed.files.filter(file => file.name !== 'knowledge-update-test.md')) {
    const read = await readKnowledge(drive, config, { file_id: file.file_id });
    if (read.status !== 'ok') return read;
    files.push(read);
  }
  const report = inspectKnowledge(files);
  // 既存本文に残った秘密情報らしい文字列も点検で知らせる（値は返さない）
  for (const file of files) {
    for (const kind of new Set(findSecrets(file.content).map(s => s.kind))) {
      report.issues.push({ code: 'secret', file: file.name, message: `秘密情報らしい文字列（${kind}）があります` });
    }
  }
  return { status: 'ok', ...report, semantic_verification: false };
}

export async function searchKnowledge(drive, config, input) {
  if (typeof input?.query !== 'string' || !input.query.trim() || input.query.length > 200 || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 8))) return { status: 'invalid_request', message: 'queryは1〜200文字、limitは1〜8です' };
  if (input.file_ids !== undefined && (!Array.isArray(input.file_ids) || !input.file_ids.length || input.file_ids.length > 8 || input.file_ids.some(id => typeof id !== 'string' || !id))) return { status: 'invalid_request', message: 'file_idsは1〜8件のファイルIDです' };
  const listed = await listKnowledge(drive, config);
  const files = listed.files.filter(file => file.name !== 'knowledge-update-test.md');
  const candidates = input.file_ids ? files.filter(file => input.file_ids.includes(file.file_id)) : routeFiles(files, input.query);
  if (input.file_ids && new Set(input.file_ids).size !== candidates.length) return { status: 'invalid_request', message: '対象外または存在しないfile_idsがあります' };
  if (!candidates.length) return { status: 'ok', complete: false, evidence_only: true, matches: [], files_read: [], needs_scope: true, message: '対象分野を判断できません。file_idsで対象を指定するか、質問に分野名を加えてください' };
  const matches = [], filesRead = [];
  for (const file of candidates) {
    const read = await readKnowledge(drive, config, { file_id: file.file_id, query: input.query, limit: input.limit ?? 5 });
    if (read.status !== 'ok') return read;
    filesRead.push({ file_id: file.file_id, name: file.name, modified_time: read.modified_time });
    matches.push(...read.matches.map(m => ({ ...m, file_id: file.file_id, modified_time: read.modified_time })));
  }
  return { status: 'ok', query: input.query, complete: false, evidence_only: true, matches: matches.sort((a, b) => b.score - a.score).slice(0, input.limit ?? 5), files_read: filesRead, needs_scope: false, message: '関連箇所の候補であり網羅的な一覧ではありません。全体を列挙するときは見出しの内容も取得し、時系列・確認範囲・現在の本人指示と照合してください。検索本文をfull保存に使わないでください' };
}
