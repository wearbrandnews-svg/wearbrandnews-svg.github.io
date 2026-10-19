import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pruneBackups, readKnowledge, safeUpdate, tokyoStamp } from '../src/knowledge.js';
import { handleMcp } from '../src/mcp.js';

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
    async uploadContent(id, text) {
      calls.push(['upload', id]);
      const f = files.get(id);
      f.body = text;
      touch(f);
      return { id, modifiedTime: f.modifiedTime };
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

test('verification failure is reported and not recorded', async () => {
  const { drive, file } = setup();
  drive.download = async (id) => (drive.calls.push(['download', id]), drive.files.get(id).body + (drive.calls.length > 3 ? '!' : ''));
  const out = await safeUpdate(drive, config, { file_id: 'T', expected_modified_time: file.modifiedTime, request_id: 'r1', mode: 'full', content: 'new' });
  assert.equal(out.status, 'verification_failed');
  assert.equal(out.match, false);
  assert.deepEqual(file.appProperties, {});
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
  assert.deepEqual(names, ['list_shared_knowledge', 'read_shared_knowledge', 'safe_update_shared_knowledge']);
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
