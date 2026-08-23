# OAuth Guide

How to configure OAuth providers and scopes for the workbench login flow.

## Provider configuration

Each provider declares:

- `clientId` and `clientSecret` for the application.
- `authorizeUrl` and `tokenUrl` for the OAuth endpoints.
- `scopes` the application requests.

## Redirect handling

The application redirects the browser to the provider's `authorizeUrl`. After
the user consents, the provider redirects back to the registered callback with
an authorization code. Exchange the code at `tokenUrl` to receive an access
token and a refresh token.

## Troubleshooting

- Redirect URI mismatch: register the exact callback URL in the provider console.
- Scope changes: users must re-consent when scopes change.
