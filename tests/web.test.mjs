import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createServer } from '../apps/web/server.mjs';

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-web-'));
  fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({
    version: '1', workspace: { id: 'web-test', name: 'Web Test' }, environment: { node: { version: '22' } },
  }));
  const server = createServer({ root, manifestPath: path.join(root, 'workspace.json') }).listen(0);
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); await once(server, 'close'); }
}

test('dashboard serves status JSON and static assets', async () => {
  await withServer(async (base) => {
    const status = await fetch(`${base}/api/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).workspace.id, 'web-test');
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/unknown`)).status, 404);
  });
});
test('dashboard exposes bilingual language controls', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'apps/web/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(process.cwd(), 'apps/web/app.js'), 'utf8');
  assert.match(html, /language-select/);
  assert.match(html, /简体中文/);
  assert.match(html, /English/);
  assert.match(app, /localStorage/);
  assert.match(app, /zh-CN/);
  assert.match(app, /en/);
});