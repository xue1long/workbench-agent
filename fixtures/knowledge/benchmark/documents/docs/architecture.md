# Architecture

This repository implements an OAuth login flow for the workbench.

## Design

The login flow uses a redirect-based OAuth provider flow: the client redirects
to the provider, the provider redirects back with an authorization code, and
the client exchanges the code for a token.

## Components

- `src/auth/oauth.js` implements the provider redirect exchange.
- `src/auth/tokens.js` stores and refreshes access tokens.
- `docs/oauth-guide.md` documents provider configuration.

## Decisions

- Tokens are stored server-side; the client only holds a session identifier.
- Refresh tokens rotate on every use.
