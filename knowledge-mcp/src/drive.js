// Google Drive API v3 の最小クライアント。getToken(force) はアクセストークンを返す。
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export class DriveError extends Error {
  constructor(status, body) {
    super(`Drive API ${status}: ${body.slice(0, 300)}`);
    this.status = status;
  }
}

export function createDrive(getToken, fetchImpl = fetch) {
  async function call(url, init = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await getToken(attempt > 0);
      const response = await fetchImpl(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
      });
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw new DriveError(response.status, await response.text());
      return response;
    }
    throw new Error('unreachable');
  }

  const json = async (url, init) => (await call(url, init)).json();
  const jsonInit = (method, body) => ({
    method,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });

  return {
    getMeta: (id, fields) => json(`${API}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`),

    download: async (id) => {
      const response = await call(`${API}/${encodeURIComponent(id)}?alt=media`);
      return new TextDecoder('utf-8').decode(await response.arrayBuffer());
    },

    uploadContent: (id, text, appProperties) => {
      const boundary = `knowledge_${crypto.randomUUID()}`;
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ appProperties })}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--\r\n`;
      return json(`${UPLOAD}/${encodeURIComponent(id)}?uploadType=multipart&fields=id,modifiedTime,version`, {
        method: 'PATCH',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: new TextEncoder().encode(body),
      });
    },

    setAppProperties: (id, appProperties) =>
      json(`${API}/${encodeURIComponent(id)}?fields=id,modifiedTime`, jsonInit('PATCH', { appProperties })),

    copy: (id, name, parentId) =>
      json(`${API}/${encodeURIComponent(id)}/copy?fields=id,name`, jsonInit('POST', { name, parents: [parentId] })),

    list: (q, orderBy = 'createdTime desc', pageToken) => {
      const params = new URLSearchParams({
        q,
        orderBy,
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,createdTime,modifiedTime,mimeType)',
      });
      if (pageToken) params.set('pageToken', pageToken);
      return json(`${API}?${params}`);
    },

    trash: (id) => json(`${API}/${encodeURIComponent(id)}?fields=id,trashed`, jsonInit('PATCH', { trashed: true })),
  };
}
