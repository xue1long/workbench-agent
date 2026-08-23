import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspaceStatus } from '../../core/status.mjs';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
}

export function createServer({ root = path.resolve(webRoot, '../..'), manifestPath = path.join(root, 'workspace.json') } = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method Not Allowed');
      if (req.url === '/api/status') {
        return send(res, 200, 'application/json', JSON.stringify(await getWorkspaceStatus(manifestPath)));
      }
      const asset = req.url === '/' ? 'index.html' : req.url === '/app.js' ? 'app.js' : null;
      if (!asset) return send(res, 404, 'text/plain', 'Not Found');
      const type = asset.endsWith('.js') ? 'text/javascript' : 'text/html';
      return send(res, 200, type, await fs.readFile(path.join(webRoot, asset), 'utf8'));
    } catch (error) {
      return send(res, 500, 'application/json', JSON.stringify({ error: error?.message ?? 'Internal Server Error' }));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  createServer().listen(port, () => console.log(`workbench dashboard listening on http://localhost:${port}`));
}