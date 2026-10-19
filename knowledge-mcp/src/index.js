// Cloudflare Worker：AI Knowledge リモートMCPサーバー（Makeの保存シナリオの置き換え）。
// MCPクライアント（Claude・ChatGPT・Codex）にはこのWorkerがOAuthサーバーとして振る舞い、
// 本人のGoogleアカウント（ALLOWED_EMAIL）でログインできた場合だけ接続を許可する。
import { AuthorizationError, CimdFetchError, OAuthProvider, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { createDrive } from './drive.js';
import { exchangeGoogleCode, getDriveToken, googleAuthorizeUrl, pkceChallenge } from './google.js';
import { handleMcp } from './mcp.js';
import { safeUpdate } from './knowledge.js';
import { SerialQueue } from './coordinator.js';

export class KnowledgeCoordinator {
  constructor(state, env) {
    this.env = env;
    this.queue = new SerialQueue();
  }
  async fetch(request) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const input = await request.json();
    return this.queue.run(async () => {
      try {
        const drive = createDrive(force => getDriveToken(this.env, force));
        const config = { knowledgeFolderId: this.env.KNOWLEDGE_FOLDER_ID, backupFolderId: this.env.BACKUP_FOLDER_ID };
        return Response.json(await safeUpdate(drive, config, input));
      } catch (error) {
        return Response.json({ status: 'error', message: String(error?.message || error) });
      }
    });
  }
}

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function htmlPage(title, body, headers = new Headers(), status = 200) {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.6">${body}</body></html>`;
  return new Response(html, { status, headers });
}

function consentPage(details, handle, headers) {
  const origin = details.clientDomain
    ? `提供元：<strong>${escape(details.clientDomain)}</strong>`
    : 'このアプリは自己登録のため、名前は検証されていません。';
  const loopback = details.redirectIsLoopback
    ? '<p><strong>このPC上のアプリにアクセス権を渡します。</strong>自分で接続を始めた場合だけ続けてください。</p>'
    : '';
  return htmlPage(
    'AI Knowledge への接続',
    `<h1>${escape(details.clientName)} を AI Knowledge に接続しますか？</h1>
<p>${origin}<br>アクセス権の送信先：<strong>${escape(details.redirectHost)}</strong></p>${loopback}
<p>許可すると、Googleアカウントでのログインに進みます。</p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">許可してGoogleでログイン</button>
<button name="decision" value="deny">拒否</button></form>`,
    headers,
  );
}

const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    const redirectUri = `${url.origin}/callback`;
    try {
      if (url.pathname === '/authorize' && request.method === 'GET') {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        return consentPage(details, consent.handle, consent.headers);
      }

      if (url.pathname === '/authorize' && request.method === 'POST') {
        const form = await request.formData();
        const handle = String(form.get('handle'));
        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(request, handle);
        const verifier = crypto.randomUUID() + crypto.randomUUID();
        const { state, headers } = await oauth.beginUpstream(approved.request, {
          data: { verifier },
          headers: approved.headers,
        });
        headers.set('Location', googleAuthorizeUrl(env, { redirectUri, state, codeChallenge: await pkceChallenge(verifier) }));
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === '/callback') {
        const { request: original, data, headers } = await oauth.finishUpstream(request);
        const code = url.searchParams.get('code');
        if (url.searchParams.get('error') || !code) {
          headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
          return new Response(null, { status: 302, headers });
        }
        const google = await exchangeGoogleCode(env, { code, redirectUri, verifier: data.verifier });
        if (!google.allowed) {
          headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
          return new Response(null, { status: 302, headers });
        }
        const { redirectTo } = await oauth.completeAuthorization({
          request: original,
          userId: google.email,
          metadata: { label: google.email },
          scope: original.scope,
          props: { email: google.email },
        });
        headers.set('Location', redirectTo);
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === '/') {
        return htmlPage('AI Knowledge MCP', `<h1>AI Knowledge MCP</h1><p>MCPエンドポイント：<code>${escape(url.origin)}/mcp</code></p>`);
      }
      return new Response('Not Found', { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const message = error instanceof AuthorizationError ? error.description : 'このアプリを確認できませんでした。';
        return htmlPage('接続エラー', `<p>${escape(message)}</p><p>接続をやり直してください。</p>`, new Headers(), 400);
      }
      throw error;
    }
  },
};

const apiHandler = {
  async fetch(request, env) {
    const deps = {
      drive: createDrive((force) => getDriveToken(env, force)),
      config: { knowledgeFolderId: env.KNOWLEDGE_FOLDER_ID, backupFolderId: env.BACKUP_FOLDER_ID },
      update: async input => {
        if (typeof input?.file_id !== 'string' || !input.file_id) return { status: 'invalid_request', message: 'file_idが必要です' };
        // No public endpoint bypasses OAuth; the DO is reached only by this binding.
        if (!env.KNOWLEDGE_WRITES) return { status: 'error', message: '保存調整用の接続がありません。保存せず停止しました' };
        const stub = env.KNOWLEDGE_WRITES.get(env.KNOWLEDGE_WRITES.idFromName(input.file_id));
        const response = await stub.fetch('https://knowledge.internal/update', { method: 'POST', body: JSON.stringify(input) });
        if (!response.ok) throw new Error(`保存調整エラー：${response.status}`);
        return response.json();
      },
    };
    return handleMcp(request, deps);
  },
};

// resource URL はデプロイ先のオリジン（workers.devのサブドメイン）から決める
const providers = new Map();
function providerFor(origin) {
  if (!providers.has(origin)) {
    providers.set(
      origin,
      new OAuthProvider({
        apiRoute: '/mcp',
        apiHandler,
        defaultHandler,
        authorizeEndpoint: '/authorize',
        tokenEndpoint: '/token',
        clientRegistrationEndpoint: '/register',
        clientIdMetadataDocumentEnabled: true,
        scopesSupported: ['knowledge'],
        refreshTokenIdleTTL: 90 * 24 * 3600,
        resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      }),
    );
  }
  return providers.get(origin);
}

export default {
  fetch(request, env, ctx) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
};
