// Token storage and refresh utilities for the OAuth login flow.
export class TokenStore {
  constructor(backend) {
    this.backend = backend;
  }

  async save(sessionId, tokens) {
    return this.backend.put(`session:${sessionId}`, tokens);
  }

  async load(sessionId) {
    return this.backend.get(`session:${sessionId}`);
  }

  async refresh(provider, refreshToken) {
    // Exchange a refresh token for a new access token; rotate the refresh
    // token on every use and update expiry.
    const next = await provider.refresh(refreshToken);
    next.issuedAt = Date.now();
    next.expiresAt = Date.now() + next.expiresIn * 1000;
    return next;
  }
}

export function isExpired(tokens) {
  return typeof tokens.expiresAt === 'number' && tokens.expiresAt < Date.now();
}
