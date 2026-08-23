// Offline OAuth demo for the Level 2 acceptance scenario. No network calls,
// no real credentials — the function merely produces a deterministic URL
// shape and validates the OAuth ``state`` parameter.

export function buildAuthorizationUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, response_type: 'code' });
  return `https://auth.example.com/authorize?${params.toString()}`;
}

export function validateCallback({ state, receivedState }) {
  if (typeof receivedState !== 'string' || receivedState.length === 0) return false;
  return state === receivedState;
}
