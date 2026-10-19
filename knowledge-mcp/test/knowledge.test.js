import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pruneBackups, readKnowledge, safeUpdate, tokyoStamp, searchKnowledge } from '../src/knowledge.js';
import { searchMarkdown, routeFiles } from '../src/search.js';
import { handleMcp } from '../src/mcp.js';
import { inspectKnowledge, selectMarkdown } from '../src/markdown.js';
import { SerialQueue } from '../src/coordinator.js';
import { createDrive } from '../src/drive.js';

const config = { knowledgeFolderId: 'KNOW', backupFolderId: 'BACK' };

// Drive の挙動を最小限まねる偽物。modifiedTime は書込みのたびに進む
function fakeDrive(initialFiles = {}) {
  let clock = Date.parse('2026-10-19T00:00:00.000Z');
  let nextId = 1;
  const files = new Map();
  const tick = () => new Date((clock += 1000)).toISOString();
  const add = (file) => {
    const id = file.id || `f${nextId++}`;
    files.set(id, {
      id,
      mimeType: 'text/markdown',
      parents: ['KNOW'],
      trashed: false,
      version: '1',
      appProperties: {},
      body: '',
      createdTime: tick(),
      modifiedTime: tick(),
      ...file,
    });
    return files.get(id);
  };
  for (const [id, file] of Object.entries(initialFiles)) add({ id, ...file });
  const touch = (file) => {
    file.modifiedTime = tick();
    file.version = String(Number(file.version) + 1);
  };
  const calls = [];
  const drive = {
    files,
    calls,
    add,
    async getMeta(id) {
      calls.push(['getMeta', id]);
      const f = files.get(id);
      if (!f) throw new Error('404');
      const { body, ...meta } = f;
      return structuredClone(meta);
    },
    async download(id) {
      calls.push(['download', id]);
      return files.get(id).body;
    },
    async uploadContent(id, text, props) {
      calls.push(['upload', id]);
      const f = files.get(id);
      f.body = text;
      if (props) f.appProperties = { ...f.appProperties, ...props };
      touch(f);
      return { id, modifiedTime: f.modifiedTime, version: f.version };
    },
    async setAppProperties(id, props) {
      calls.push(['props', id]);
      const f = files.get(id);
      f.appProperties = { ...f.appProperties, ...props };
      touch(f);
      return { id, modifiedTime: f.modifiedTime };
    },
    async copy(id, name, parent) {
      calls.push(['copy', id]);
      const src = files.get(id);
      return add({ name, parents: [parent], body: src.body, appProperties: {} });
    },
    async list(q) {
      const parent = /'([^']+)' in parents/.exec(q)[1];
      const contains = /name contains '([^']+)'/.exec(q)?.[1];
      const result = [...files.values()].filter(
        (f) => f.parents.includes(parent) && !f.trashed && (!contains || f.name.includes(contains)),
      );
      return { files: result.map(({ body, ...m }) => m) };
    },
    async trash(id) {
      calls.push(['trash', id]);
      files.get(id).trashed = true;
      return { id, trashed: true };
    },
  };
  return drive;
}

const setup = (body = '# test\n') => {
  const drive = fakeDrive({ T: { name: 'knowledge-update-test.md', body } });
  return { drive, file: drive.files.get('T') };
};

test('append saves, backs up and verifies', async () => {
  const { drive, file } = setup('# test\n');
  const before = file.modifiedTime;
  const out = await safeUpdate(drive, config, {
    file_id: 'T', expected_modified_time: before, request_id: 'r1', mode: 'append', content: '- 追記 $& \\ "\n',
  });
  assert.equal(out.status, 'saved');
  assert.equal(out.match, true);
  assert.equal(out.file_id, 'T');
  assert.equal(file.body, '# test\n- 追記 $& \\ "\n');
  assert.equal(out.length, file.body.length);
  assert.equal(out.modified_time, file.modifiedTime);
  const backup = drive.files.get(out.backup_file_id);
  assert.equal(backup.body, '# test\n');
  assert.deepEqual(backup.parents, ['BACK']);
  assert.match(backup.name, /^knowledge-update-test\.md-backup-\d{8}-\d{6}-\d{3}\.md$/);
});

test('resend with same input returns already_applied without writing', async () => {
  const { drive, file } = setup();
  const input = { file_id: 'T', expected_modified_time: file.modifiedTime, request_id: 'r1', mode: 'append', content: 'x\n' };
  const first = await safeUpdate(drive, config, input);
  const writes = drive.calls.filter((c) => c[0] === 'upload' || c[0] === 'copy').length;
  const second = await safeUpdate(drive, config, input);
  assert.equal(second.status, 'already_applied');
  assert.equal(second.match, true);
  assert.equal(second.backup_file_id, first.backup_file_id);
  assert.equal(file.body, '# test\nx\n');
  assert.equal(drive.calls.filter((c) => c[0] === 'upload' || c[0] === 'copy').length, writes);
});

test('stale version is rejected as conflict', async () => {
  const { drive, file } = setup();
  const stale = file.modifiedTime;
  await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: stale, request_id: 'r1', mode: 'append', content: 'a' });
  const body = file.body;
  const out = await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: stale, request_id: 'r2', mode: 'append', content: 'b' });
  assert.equal(out.status, 'conflict');
  assert.equal(file.body, body);
});

test('reused request_id with different input is rejected', async () => {
  const { drive, file } = setup();
  await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: file.modifiedTime, request_id: 'r1', mode: 'append', content: 'a' });
  const out = await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: file.modifiedTime, request_id: 'r1', mode: 'append', content: 'b' });
  assert.equal(out.status, 'invalid_request');
});

test('replace_exact requires exactly one literal match', async () => {
  const { drive, file } = setup('a $1 b a\n');
  const t = () => file.modifiedTime;
  let out = await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: t(), request_id: 'r1', mode: 'replace_exact', old_text: 'a', content: 'z' });
  assert.equal(out.status, 'invalid_request');
  out = await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: t(), request_id: 'r2', mode: 'replace_exact', old_text: 'nope', content: 'z' });
  assert.equal(out.status, 'invalid_request');
  out = await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: t(), request_id: 'r3', mode: 'replace_exact', old_text: '$1', content: '$&' });
  assert.equal(out.status, 'saved');
  assert.equal(file.body, 'a $& b a\n');
});

test('full mode rejects empty content and files outside the folder', async () => {
  const { drive, file } = setup();
  let out = await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: file.modifiedTime, request_id: 'r1', mode: 'full', content: '' });
  assert.equal(out.status, 'invalid_request');
  drive.add({ id: 'O', name: 'other.md', parents: ['ELSEWHERE'], body: 'x' });
  out = await safeUpdate(drive, config, { file_id: 'O', expected_modified_time: drive.files.get('O').modifiedTime, request_id: 'r2', mode: 'full', content: 'y' });
  assert.equal(out.status, 'invalid_request');
  assert.equal(drive.files.get('O').body, 'x');
});

test('verification failure is reported without claiming success', async () => {
  const { drive, file } = setup();
  drive.download = async (id) => (drive.calls.push(['download', id]), drive.files.get(id).body + (drive.calls.length > 3 ? '!' : ''));
  const out = await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: file.modifiedTime, request_id: 'r1', mode: 'full', content: 'new' });
  assert.equal(out.status, 'verification_failed');
  assert.equal(out.match, false);
  assert.equal(typeof file.appProperties.kmAfter, 'string');
});

test('prune keeps newest 20 backups of the same file only', async () => {
  const drive = fakeDrive();
  for (let i = 0; i < 22; i += 1) {
    drive.add({ name: `k.md-backup-20261019-0000${String(i).padStart(2, '0')}-000.md`, parents: ['BACK'] });
  }
  drive.add({ name: 'k.md-backup-old.md', parents: ['BACK'] });
  drive.add({ name: 'kk.md-backup-20261019-000000-000.md', parents: ['BACK'] });
  const res = await pruneBackups(drive, config, 'k.md');
  assert.equal(res.trashed.length, 2);
  const trashedNames = res.trashed.map((id) => drive.files.get(id).name).sort();
  assert.deepEqual(trashedNames, ['k.md-backup-20261019-000000-000.md', 'k.md-backup-20261019-000001-000.md']);
});

test('read returns raw content and modified time', async () => {
  const { drive, file } = setup('# 生の本文\n');
  const out = await readKnowledge(drive, config, { file_id: 'T' });
  assert.equal(out.content, '# 生の本文\n');
  assert.equal(out.modified_time, file.modifiedTime);
});

test('tokyoStamp uses UTC+9', () => {
  assert.equal(tokyoStamp(new Date('2026-10-18T13:42:12.345Z')), '20261018-224212-345');
});

test('MCP handshake, tool list and tool call', async () => {
  const { drive, file } = setup();
  const deps = { drive, config };
  const post = (body) => handleMcp(new Request('https://x/mcp', { method: 'POST', body: JSON.stringify(body) }), deps);
  let res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal((await res.json()).result.protocolVersion, '2025-06-18');
  res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.status, 202);
  res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (await res.json()).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['list_shared_knowledge', 'read_shared_knowledge', 'search_shared_knowledge', 'check_shared_knowledge', 'safe_update_shared_knowledge']);
  res = await post({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'safe_update_shared_knowledge', arguments: { file_id: 'T', expected_modified_time: file.modifiedTime, request_id: 'r', mode: 'append', content: 'z' } },
  });
  const call = (await res.json()).result;
  assert.equal(call.isError, false);
  assert.equal(call.structuredContent.status, 'saved');
  res = await handleMcp(new Request('https://x/mcp'), deps);
  assert.equal(res.status, 405);
});

test('lost upload response recovers without duplicate append or backup', async () => {
  const { drive, file } = setup('before\n');
  const upload = drive.uploadContent;
  const input = { file_id: 'T', expected_modified_time: file.modifiedTime, request_id: 'lost', mode: 'append', content: 'after\n' };
  drive.uploadContent = async (...args) => { await upload(...args); throw new Error('response lost'); };
  await assert.rejects(safeUpdate(drive, config, input), /response lost/);
  const copies = drive.calls.filter(c => c[0] === 'copy').length;
  const out = await safeUpdate(drive, config, input);
  assert.equal(out.status, 'already_applied');
  assert.equal(file.body, 'before\nafter\n');
  assert.equal(drive.calls.filter(c => c[0] === 'copy').length, copies);
});

test('parallel writes through file queue permit one save and reject stale second write', async () => {
  const { drive, file } = setup();
  const queue = new SerialQueue();
  const base = file.modifiedTime;
  const results = await Promise.all(['one', 'two'].map(request_id => queue.run(() => safeUpdate(drive, config, { file_id: 'T', expected_modified_time: base, request_id, mode: 'append', content: request_id }))));
  assert.deepEqual(results.map(r => r.status), ['saved', 'conflict']);
  assert.equal(file.body, '# test\none');
  assert.equal(drive.calls.filter(c => c[0] === 'copy').length, 1);
});

test('file queue recovers after a failed operation', async () => {
  const queue = new SerialQueue();
  const failed = queue.run(async () => { throw new Error('failed'); });
  const next = queue.run(async () => 42);
  await assert.rejects(failed, /failed/);
  assert.equal(await next, 42);
});

test('external change during backup is rejected before upload', async () => {
  const { drive, file } = setup();
  const base = file.modifiedTime, copy = drive.copy;
  drive.copy = async (...args) => { const result = await copy(...args); await drive.uploadContent('T', 'external edit'); return result; };
  const out = await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: base, request_id: 'r', mode: 'full', content: 'mine' });
  assert.equal(out.status, 'conflict');
  assert.equal(file.body, 'external edit');
});

test('partial heading includes subheadings and ignores headings in fences', () => {
  const body = '# Root\n## A\ntext\n```\n## B\n```\n### Child\nmore\n## B\nother\n';
  const out = selectMarkdown(body, { section: 'A' });
  assert.equal(out.complete, false);
  assert.ok(out.content.includes('### Child'));
  assert.ok(!out.content.includes('other'));
  assert.ok(selectMarkdown(body, { section: 'missing' }).error);
  assert.ok(selectMarkdown(body, { section: 'A', product_ids: ['DEV-001'] }).error);
});

test('partial product reads retain table headings and reject missing IDs', () => {
  const body = '# Products\n## Devices\n| ID | Name |\n|---|---|\n| DEV-001 | One |\n| DEV-002 | Two |\n';
  const out = selectMarkdown(body, { product_ids: ['DEV-002'] });
  assert.ok(out.content.includes('| ID | Name |'));
  assert.ok(out.content.includes('Two'));
  assert.ok(!out.content.includes('One'));
  assert.ok(selectMarkdown(body, { product_ids: ['DEV-999'] }).error);
  assert.ok(selectMarkdown(body, { product_ids: ['DEV-002', 'DEV-999'] }).error);
});

test('read retries an inconsistent snapshot and returns current body and version', async () => {
  const { drive, file } = setup('old');
  const download = drive.download;
  let first = true;
  drive.download = async id => { const content = await download(id); if (first) { first = false; await drive.uploadContent(id, 'new'); } return content; };
  const out = await readKnowledge(drive, config, { file_id: 'T' });
  assert.equal(out.content, 'new');
  assert.equal(out.modified_time, file.modifiedTime);
  assert.equal(out.complete, true);
});

test('checks catch malformed tables, duplicate IDs and broken references', () => {
  const out = inspectKnowledge([{ name: 'products.md', content: '| ID | Name |\n|---|---|\n| DEV-001 | one | extra |\n| DEV-001 | duplicate |\n' }, { name: 'other.md', content: 'DEV-999\n```\nDEV-888\n```\n' }]);
  assert.ok(out.issues.some(i => i.code === 'table_columns'));
  assert.ok(out.issues.some(i => i.code === 'duplicate_id'));
  assert.ok(out.issues.some(i => i.code === 'missing_id' && i.id === 'DEV-999'));
  assert.ok(!out.issues.some(i => i.id === 'DEV-888'));
});

test('save blocks a newly malformed table before any backup', async () => {
  const { drive, file } = setup('| A | B |\n|---|---|\n| one | two |\n');
  const out = await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: file.modifiedTime, request_id: 'bad-table', mode: 'append', content: '| x | y | z |\n' });
  assert.equal(out.status, 'invalid_request');
  assert.equal(drive.calls.filter(c => c[0] === 'copy').length, 0);
});

test('multipart upload carries exact UTF-8 content and retry markers in one PATCH', async () => {
  const requests = [];
  const drive = createDrive(async () => 'test-token', async (url, init) => { requests.push({ url, init }); return Response.json({ id: 'T', version: '2', modifiedTime: 'now' }); });
  const body = '# 日本語\n"quote" \\ $& 😀\n';
  await drive.uploadContent('T', body, { kmReq: 'request-hash' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, 'PATCH');
  assert.ok(requests[0].url.includes('uploadType=multipart'));
  const wire = new TextDecoder().decode(requests[0].init.body);
  assert.ok(wire.includes(body));
  assert.ok(wire.includes('"kmReq":"request-hash"'));
});

test('search routes supplement questions only to relevant domains', () => {
  const files = ['products.md', 'health-training.md', 'smart-home.md', 'AI-Rules.md'].map(name => ({ name }));
  assert.deepEqual(routeFiles(files, '昼ご飯の前に飲むサプリ'), files.slice(0, 2));
});

test('unknown search scope reads no personal file bodies', async () => {
  const { drive } = setup();
  const out = await searchKnowledge(drive, config, { query: 'あれはどう？' });
  assert.equal(out.needs_scope, true);
  assert.equal(drive.calls.filter(c => c[0] === 'download').length, 0);
});

test('search prioritizes a product definition over historical mentions', () => {
  const text = '# Products\n## Items\n| ID | Name | State |\n|---|---|---|\n| GEAR-001 | Shoe X | 購入予定 |\n## 更新履歴\n- GEAR-001の購入予定を記録\n';
  const result = searchMarkdown(text, 'products.md', '今のGEAR-001は？');
  assert.ok(result[0].text.includes('| GEAR-001 |'));
  assert.equal(result[0].history, false);
});

test('search maps Japanese hour expressions and includes table headers', () => {
  const text = '# 習慣\n## 時刻\n| 時刻 | 行動 |\n|---|---|\n| 11:00 | 昼食1時間前 |\n| 19:00 | 夕食 |\n';
  const result = searchMarkdown(text, 'health-training.md', '11時は昼ご飯の何分前？');
  assert.ok(result[0].text.includes('11:00'));
  assert.ok(result[0].text.includes('| 時刻 | 行動 |'));
});

test('search keeps the section provenance with a product row', () => {
  const text = '# Products\n## Items\n2026-10-20、本人提示資料で確認。現品未確認。\n\n| ID | Name |\n|---|---|\n| DEV-001 | Device X |\n';
  const result = searchMarkdown(text, 'products.md', 'DEV-001');
  assert.ok(result[0].source_notes.includes('現品未確認'));
  assert.ok(result[0].line_start > 0);
});

test('search does not expose fenced examples as evidence', () => {
  const text = '# Test\n```\n秘密の語句\n```\n通常の説明\n';
  assert.equal(searchMarkdown(text, 'test.md', '秘密の語句').length, 0);
});

test('file search is partial and cannot be combined with section selection', async () => {
  const { drive } = setup('# Memo\n## A\nサプリの時刻は未確認\n');
  let out = await readKnowledge(drive, config, { file_id: 'T', query: 'サプリ' });
  assert.equal(out.complete, false);
  assert.equal(out.evidence_only, true);
  out = await readKnowledge(drive, config, { file_id: 'T', query: 'サプリ', section: 'A' });
  assert.equal(out.status, 'invalid_request');
});

test('cross-file search respects explicit scope and excludes test files', async () => {
  const drive = fakeDrive({ P: { name: 'products.md', body: '# P\nサプリの製品情報\n' }, H: { name: 'health-training.md', body: '# H\nサプリの使い方\n' }, T: { name: 'knowledge-update-test.md', body: '# Test\nサプリの試験\n' } });
  const out = await searchKnowledge(drive, config, { query: 'サプリ', file_ids: ['H'] });
  assert.deepEqual(out.files_read.map(f => f.file_id), ['H']);
  const invalid = await searchKnowledge(drive, config, { query: 'サプリ', file_ids: ['T'] });
  assert.equal(invalid.status, 'invalid_request');
});

test('search rejects oversized queries and non-integer limits before reads', async () => {
  const { drive } = setup();
  for (const args of [{ query: '' }, { query: 'x'.repeat(201) }, { query: '薬', limit: 1.5 }]) {
    assert.equal((await searchKnowledge(drive, config, args)).status, 'invalid_request');
  }
  assert.equal(drive.calls.length, 0);
});

test('no-match search preserves the distinction between not found and not existing', async () => {
  const { drive } = setup('# Memo\n既知の情報\n');
  const out = await readKnowledge(drive, config, { file_id: 'T', query: 'zzzzunique' });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.matches, []);
  assert.ok(out.message.includes('存在しないとは断定せず'));
});
