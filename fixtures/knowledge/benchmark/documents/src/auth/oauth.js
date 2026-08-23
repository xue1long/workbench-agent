// OAuth login flow: provider redirect exchange.
// The client redirects to the provider, receives an authorization code,
// and exchanges it for tokens.
export async function oauthLogin(provider, { clientId, redirectUri }) {
  const authorizeUrl = buildAuthorizeUrl(provider, { clientId, redirectUri });
  return { redirect: authorizeUrl, state: provider.state };
}

export function exchangeCode(provider, code, { clientId, clientSecret, redirectUri }) {
  // POST to provider.tokenUrl with the authorization code.
  return provider.exchange({ code, clientId, clientSecret, redirectUri });
}

export function buildAuthorizeUrl(provider, { clientId, redirectUri }) {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scopes.join(' '));
  return url.toString();
}
