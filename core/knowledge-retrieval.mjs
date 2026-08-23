// Level 3 Task 7: deterministic scoped retrieval with a context budget.
//
// Retrieval is deliberately NOT semantic: scoring is a pure function of
// term overlap, path tokens, scope, and kind. The scope boundary is hard —
// an item whose scope is not within the query scope is excluded before
// scoring and can never be returned. Items are packed in score order until
// the fixed context budget is exhausted; every returned item carries its
// exact sourcePath and contentHash so the caller can cite it.
//
// `index` is an array of items shaped like knowledge-index rows with the
// content available inline:
//   { sourcePath, contentHash, scope, kind, content }

export class KnowledgeRetrievalError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'KnowledgeRetrievalError';
    this.code = code;
    if (details) this.details = details;
  }
}

function normalizeTerms(text) {
  const tokens = new Set();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_\-.]+/)) {
    if (raw.length >= 2) tokens.add(raw);
  }
  return tokens;
}

function scopeContains(scope, queryScope) {
  const q = queryScope.replace(/\/+$/, '');
  const s = scope.replace(/\/+$/, '');
  return s === q || s.startsWith(`${q}/`) || q === '' || q === '.';
}

function excerptAround(content, term, radius = 120) {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(term);
  if (idx < 0) return content.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + term.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return `${prefix}${content.slice(start, end)}${suffix}`;
}

export function retrieve({ index, query, scope, budgetChars = 8000, kind = null }) {
  if (!Array.isArray(index)) {
    throw new KnowledgeRetrievalError('RETRIEVAL_INDEX_INVALID', 'index must be an array');
  }
  if (typeof query !== 'string' || !query.trim()) {
    throw new KnowledgeRetrievalError('RETRIEVAL_QUERY_INVALID', 'query must be a non-empty string');
  }
  if (typeof scope !== 'string' || !scope.trim()) {
    throw new KnowledgeRetrievalError('RETRIEVAL_SCOPE_INVALID', 'scope must be a non-empty string');
  }
  if (typeof budgetChars !== 'number' || budgetChars < 0 || Number.isNaN(budgetChars)) {
    throw new KnowledgeRetrievalError('RETRIEVAL_BUDGET_INVALID', 'budgetChars must be a non-negative number');
  }
  const terms = normalizeTerms(query);
  let scopeCapped = 0;
  const scored = [];
  for (const item of index) {
    if (!item || typeof item.sourcePath !== 'string') continue;
    if (!scopeContains(String(item.scope ?? ''), scope)) {
      scopeCapped += 1;
      continue;
    }
    if (kind && item.kind !== kind) continue;
    const content = typeof item.content === 'string' ? item.content : '';
    const pathTokens = new Set(item.sourcePath.toLowerCase().split(/[^a-z0-9_.\-]+/));
    const contentTokens = normalizeTerms(content);
    // A term matches a token when it is equal, a prefix, or a substring —
    // so camelCase identifiers (oauthLogin) and dotted files (oauth.js)
    // still match the keyword "oauth".
    const matchToken = (term, token) => token === term || token.startsWith(term) || token.includes(term);
    const pathMatches = [...terms].filter((t) => [...pathTokens].some((tok) => matchToken(t, tok)));
    const contentMatches = [...terms].filter((t) => [...contentTokens].some((tok) => matchToken(t, tok)));
    const matched = [...new Set([...pathMatches, ...contentMatches])];
    if (matched.length === 0) continue;
    let score = pathMatches.length * 2 + contentMatches.length;
    if (scopeContains(String(item.scope ?? ''), scope) && String(item.scope).replace(/\/+$/, '') === scope.replace(/\/+$/, '')) {
      score += 0.5; // exact scope match bonus
    }
    const firstLine = content.slice(0, 200).toLowerCase();
    if (matched.some((t) => firstLine.includes(t))) score += 1;
    const firstMatch = matched.sort()[0];
    const excerpt = excerptAround(content, firstMatch);
    scored.push({
      sourcePath: item.sourcePath,
      contentHash: item.contentHash,
      scope: item.scope,
      kind: item.kind,
      score,
      matchedTerms: matched,
      excerpt,
    });
  }
  // Deterministic ordering: score desc, then sourcePath asc.
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0;
  });
  const items = [];
  let totalChars = 0;
  for (const entry of scored) {
    const charCount = Buffer.byteLength(entry.excerpt, 'utf8') + 64;
    if (totalChars + charCount > budgetChars && items.length > 0) break;
    if (totalChars + charCount > budgetChars) continue; // single item too big for budget
    items.push({ ...entry, charCount });
    totalChars += charCount;
  }
  return {
    items,
    budgetUsed: totalChars,
    totalChars,
    scopeCapped,
    query,
    scope,
    budgetChars,
    sources: items.map((i) => ({ sourcePath: i.sourcePath, contentHash: i.contentHash })),
  };
}
