// 秘密情報らしい文字列の検出（AI-Rules.md「パスワード、APIキー、認証URLなどの秘密情報は保存しない」をサーバー側でも守る）。
// 誤検出を減らすため、形式がはっきりした鍵・トークンと、認証用クエリ付きURLだけを対象にする。
// 結果には種類だけを返し、検出した値そのものは返さない。
const PATTERNS = [
  ['秘密鍵', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['Anthropic APIキー', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI APIキー', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g],
  ['GitHubトークン', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['Google APIキー', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Googleトークン', /\bya29\.[0-9A-Za-z_-]{20,}/g],
  ['Googleクライアントシークレット', /\bGOCSPX-[0-9A-Za-z_-]{20,}/g],
  ['AWSアクセスキー', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Slackトークン', /\bxox[abprs]-[0-9A-Za-z-]{10,}/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['Bearerトークン', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ['認証情報付きURL', /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/g],
  ['認証用クエリ付きURL', /\bhttps?:\/\/[^\s)]*[?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|client_secret|secret|password|sig|signature)=[^\s&)]{8,}/gi],
];

export function findSecrets(text) {
  const found = [];
  for (const [kind, pattern] of PATTERNS) {
    for (const match of text.matchAll(pattern)) found.push({ kind, value: match[0] });
  }
  return found;
}

// 既存本文にすでにある値は対象外にし、今回の保存で新しく入る秘密情報だけを返す（古い記述の修正を妨げない）
export function newSecretKinds(before, after) {
  const existing = new Set(findSecrets(before).map(s => s.value));
  return [...new Set(findSecrets(after).filter(s => !existing.has(s.value)).map(s => s.kind))];
}
