// Level 3 Task 7: deterministic scoped retrieval with a context budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieve, KnowledgeRetrievalError } from '../core/knowledge-retrieval.mjs';

function item(sourcePath, scope, content, kind = 'markdown') {
  return { sourcePath, contentHash: `h-${sourcePath}`, scope, kind, content };
}

const CORPUS = [
  item('src/auth/oauth.js', 'src/', 'export function oauthLogin(provider) { return provider.redirectUri; } oauth handles tokens and redirects.', 'code'),
  item('src/auth/tokens.js', 'src/', 'token refresh, expiry, and storage utilities.', 'code'),
  item('docs/architecture.md', 'docs/', '# Architecture\nOAuth login flow uses a redirect and token storage. Design decisions are recorded here.', 'markdown'),
  item('docs/oauth-guide.md', 'docs/', '# OAuth Guide\nHow to configure providers and scopes.', 'markdown'),
  item('notes/private.md', 'notes/', 'Personal notes about oauth experiments.', 'markdown'),
];

test('retrieval is deterministic: same input produces identical results', () => {
  const a = retrieve({ index: CORPUS, query: 'oauth token', scope: '.', budgetChars: 4000 });
  const b = retrieve({ index: CORPUS, query: 'oauth token', scope: '.', budgetChars: 4000 });
  assert.deepEqual(a, b);
});

test('out-of-scope items are never returned even on strong keyword matches', () => {
  const res = retrieve({ index: CORPUS, query: 'oauth', scope: 'src/', budgetChars: 4000 });
  for (const item of res.items) {
    assert.ok(item.scope === 'src/' || item.scope.startsWith('src/'), `scope ${item.scope} leaked`);
  }
  assert.ok(!res.items.some((i) => i.sourcePath.startsWith('docs/')), 'docs items must not leak into src/ query');
  assert.ok(!res.items.some((i) => i.sourcePath.startsWith('notes/')), 'notes items must not leak into src/ query');
  assert.equal(res.scopeCapped, 3, 'docs x2 + notes excluded');
});

test('context budget is respected and citations are present', () => {
  const res = retrieve({ index: CORPUS, query: 'oauth token', scope: '.', budgetChars: 500 });
  assert.ok(res.budgetUsed <= 500, `budgetUsed ${res.budgetUsed} exceeds budget`);
  assert.ok(res.items.length > 0);
  for (const item of res.items) {
    assert.equal(typeof item.sourcePath, 'string');
    assert.equal(typeof item.contentHash, 'string');
    assert.equal(typeof item.excerpt, 'string');
    assert.ok(item.charCount > 0);
  }
  assert.deepEqual(res.sources, res.items.map((i) => ({ sourcePath: i.sourcePath, contentHash: i.contentHash })));
});

test('higher scoring items are packed first', () => {
  const res = retrieve({ index: CORPUS, query: 'oauth', scope: '.', budgetChars: 100000 });
  const scores = res.items.map((i) => i.score);
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i - 1] >= scores[i], 'items must be in score-descending order');
  }
  // The path-match file (src/auth/oauth.js) is present and scores with the leaders.
  const oauth = res.items.find((i) => i.sourcePath === 'src/auth/oauth.js');
  assert.ok(oauth, 'path-matched item must be retrieved');
  assert.ok(oauth.score >= Math.max(...scores) - 0.5, 'path match must not be dominated by content matches');
});

test('ties are broken deterministically by sourcePath', () => {
  const index = [
    item('b.md', 'docs/', 'same keywords here'),
    item('a.md', 'docs/', 'same keywords here'),
  ];
  const res = retrieve({ index, query: 'keywords', scope: '.', budgetChars: 100000 });
  assert.deepEqual(res.items.map((i) => i.sourcePath), ['a.md', 'b.md']);
});

test('excerpt contains the matched keyword context', () => {
  const res = retrieve({ index: CORPUS, query: 'redirect', scope: '.', budgetChars: 100000 });
  const oauth = res.items.find((i) => i.sourcePath === 'src/auth/oauth.js');
  assert.ok(oauth.excerpt.toLowerCase().includes('redirect'));
});

test('no matches returns an empty result', () => {
  const res = retrieve({ index: CORPUS, query: 'zzzznomatch', scope: '.', budgetChars: 4000 });
  assert.equal(res.items.length, 0);
  assert.equal(res.budgetUsed, 0);
});

test('invalid inputs are rejected', () => {
  assert.throws(() => retrieve({ index: 'nope', query: 'x', scope: '.' }), (err) => err instanceof KnowledgeRetrievalError && err.code === 'RETRIEVAL_INDEX_INVALID');
  assert.throws(() => retrieve({ index: [], query: '', scope: '.' }), (err) => err instanceof KnowledgeRetrievalError && err.code === 'RETRIEVAL_QUERY_INVALID');
  assert.throws(() => retrieve({ index: [], query: 'x', scope: '' }), (err) => err instanceof KnowledgeRetrievalError && err.code === 'RETRIEVAL_SCOPE_INVALID');
  assert.throws(() => retrieve({ index: [], query: 'x', scope: '.', budgetChars: -1 }), (err) => err instanceof KnowledgeRetrievalError && err.code === 'RETRIEVAL_BUDGET_INVALID');
});

test('kind filter restricts result kinds', () => {
  const res = retrieve({ index: CORPUS, query: 'oauth', scope: '.', budgetChars: 100000, kind: 'code' });
  assert.ok(res.items.length > 0);
  for (const item of res.items) assert.equal(item.kind, 'code');
});
