// MCP（Streamable HTTP、ステートレス・JSON応答）の最小実装。
import { listKnowledge, readKnowledge, safeUpdate, checkKnowledge, searchKnowledge } from './knowledge.js';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'ai-knowledge', version: '1.3.0' };

const UPDATE_DESCRIPTION = `AI-Knowledgeフォルダー直下の既存Markdown（共通知識DB）を安全に更新する（Safe Update Shared Knowledge）。
保存前にread_shared_knowledgeで最新本文とmodified_timeを取得し、そのmodified_timeをexpected_modified_timeにそのまま渡す。request_idは依頼ごとにAIが生成する一意の文字列。
mode=full：contentは更新後の全文。mode=append：contentを末尾にそのまま追加（区切りの改行も含める）。mode=replace_exact：old_text（本文にちょうど1回ある完全一致文字列）をcontentに置換。
サーバーが同一ファイルの保存を順番に処理し、更新前コピー（Backups）、本文と再送判定情報の一括更新、保存後の全文照合、バックアップ20世代整理を行う。新しく生じる表の崩れ・商品ID重複は保存前に拒否する。Obsidian等の直接編集はこの順番制御の対象外。
成功判定：statusがsavedまたはalready_appliedで、matchが真偽値true、file_idが対象と一致する場合だけ。conflictは書き込まずに停止したもの（最新版を再取得して統合し、新しいrequest_idで保存し直す）。invalid_request・verification_failed・errorは完了ではない。タイムアウト・結果不明のときは本文を読み直してから判断し、同じ追記を新しいrequest_idで無条件に再送しない。`;

const TOOLS = [
  {
    name: 'list_shared_knowledge',
    description: 'AI-Knowledgeフォルダー直下のMarkdownファイル一覧（file_id・名前・modified_time）を返す。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_shared_knowledge',
    description:
      'AI-Knowledge直下のMarkdownを取得。sectionで見出し名、product_idsで商品IDを指定すると必要部分のみ返す。complete=falseの部分本文をfull保存の元に使わない。保存直前は選択条件なしで全文とmodified_timeを取得する。',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: '対象MDのDriveファイルID' },
        section: { type: 'string', description: '取得する見出し名（#を除く完全一致）。下位見出しも含む' },
        query: { type: 'string', maxLength: 200, description: 'このファイル内を自然な語句で検索する。section・product_idsと併用不可' },
        limit: { type: 'integer', minimum: 1, maximum: 8, description: 'query検索で返す最大件数。既定5件' },
        product_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50, description: '取得する商品ID。表の列見出しも含める。sectionと併用不可' },
      },
      required: ['file_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_shared_knowledge',
    description: '本人の情報が必要な相談で、自然な語句から関連分野を選んで検索。商品・使い方の根拠を確認日・見出し・行番号と返す。分野不明なら全件を無条件に読まずneeds_scope=trueを返す。AIの回答や事実検証ではなく、結果はfull保存に使えない。一般的な質問だけでは実行しない。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, file_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'check_shared_knowledge',
    description: '本番MDの表の列数・商品ID重複・参照切れを読み取りだけで点検する。専用テストMDは除く。事実の正しさ・意味の矛盾を保証するものではなく、更新もしない。通常相談では実行せず、DB点検・整理時に使う。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'safe_update_shared_knowledge',
    description: UPDATE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: '対象MDのDriveファイルID' },
        expected_modified_time: { type: 'string', description: '直前に取得したmodified_time（そのまま）' },
        request_id: { type: 'string', description: '依頼ごとの一意なID。同じ依頼の再送では全入力を変えない' },
        mode: { type: 'string', enum: ['full', 'append', 'replace_exact'] },
        content: { type: 'string', description: 'full：全文／append：追加文字列／replace_exact：置換後の文字列' },
        old_text: { type: 'string', description: 'replace_exactのときだけ。本文にちょうど1回ある完全一致文字列' },
      },
      required: ['file_id', 'expected_modified_time', 'request_id', 'mode', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

const rpcResult = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function callTool(name, args, deps) {
  if (name === 'list_shared_knowledge') return listKnowledge(deps.drive, deps.config);
  if (name === 'read_shared_knowledge') return readKnowledge(deps.drive, deps.config, args);
  if (name === 'search_shared_knowledge') return searchKnowledge(deps.drive, deps.config, args);
  if (name === 'check_shared_knowledge') return checkKnowledge(deps.drive, deps.config);
  if (name === 'safe_update_shared_knowledge') return deps.update ? deps.update(args) : safeUpdate(deps.drive, deps.config, args);
  return null;
}

async function handleMessage(message, deps) {
  const { id, method, params } = message || {};
  const isNotification = id === undefined || id === null;
  if (message?.jsonrpc !== '2.0' || typeof method !== 'string') {
    return isNotification ? null : rpcError(id, -32600, 'Invalid Request');
  }
  if (isNotification) return null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: '共通知識DB（Google Drive AI-Knowledge）の読み取りと安全な保存。保存ルールの正本はAI-Rules.md。',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      try {
        const output = await callTool(params?.name, params?.arguments || {}, deps);
        if (!output) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        const failed = !['ok', 'saved', 'already_applied'].includes(output.status);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
          isError: failed,
        });
      } catch (error) {
        const output = { status: 'error', message: String(error?.message || error) };
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(request, deps) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const message of messages) {
    const response = await handleMessage(message, deps);
    if (response) responses.push(response);
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
