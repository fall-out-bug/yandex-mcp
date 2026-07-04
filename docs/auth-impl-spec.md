# tracker-mcp Standalone OAuth Profile — Implementation Spec

For the implementing subagent. Read `docs/auth-design.md` (the design brief) and
this file fully before coding. Repo: `/home/fall_out_bug/projects/yandex-mcp`,
package: `packages/tracker-mcp` (TS, Bun, MCP SDK `@modelcontextprotocol/sdk`
1.29). v0.1 exists (env-token stdio + per-request-bearer HTTP) with 12 passing
tests — keep them green.

## Goal

Implement the **standalone MCP OAuth profile**: a connecting user authorizes via
Yandex, and tracker-mcp obtains + keeps their Yandex token server-side, issuing
its OWN MCP tokens to the host. Per-user, actions attributed to the user's
Yandex identity. No token ever reaches the MCP client / LLM.

This adds a new credential mode alongside the existing v0.1 modes; it does not
remove them (the faust-deployed per-request-bearer profile stays for later).

## Hard constraints (non-negotiable)

1. **No token passthrough** (MCP spec). The MCP client must NEVER receive the
   Yandex token. tracker-mcp issues its own opaque MCP access tokens; the Yandex
   token is stored server-side, mapped to the MCP token.
2. **Do NOT use `ProxyOAuthServerProvider`** — it is pure passthrough. Implement
   a custom `OAuthServerProvider`.
3. **Identity = the user's.** Tracker API calls use the user's Yandex token, so
   actions are attributed to them in Tracker. This is the product essence.
4. The Yandex OAuth **app is external** (deployer provides `client_id`/`secret`
   via env). tracker-mcp never creates an app.

## Verified Yandex facts (use these exactly)

- Authorize URL: `https://oauth.yandex.ru/authorize`
- Token URL: `https://oauth.yandex.ru/token` (form-encoded body)
- Scopes to request: **`cloud:auth tracker:read tracker:write`** (`cloud:auth`
  is the one that unblocks Cloud-org access).
- Code flow: `response_type=code`, exchange `grant_type=authorization_code` with
  `client_id`+`client_secret`+`redirect_uri`+`code`.
- The resulting Yandex access token works **directly** against Tracker:
  `Authorization: OAuth <token>` + header `X-Cloud-Org-Id: <org-id>` (or
  `X-Org-Id` for 360 orgs). **No IAM exchange** (IAM exchange is dead for
  federated Cloud users; do not implement it).
- Org-id is per-deployment (env `TRACKER_ORG_ID` + `TRACKER_ORG_HEADER` already
  exist in v0.1 — reuse). For this org it is `bpfd8mfc069c147a91r9` /
  `X-Cloud-Org-Id`.
- Refresh: Yandex access tokens expire; refresh via
  `grant_type=refresh_token` with `client_id`+`client_secret`+`refresh_token`.
- Yandex has **no DCR and no `.well-known`** — those are provided by OUR AS, not
  Yandex.

## What to build

### New files
- `src/auth/store.ts` — server-side token store: MCP-access-token →
  `{yandexAccess, yandexRefresh, yandexExpiresAt, scopes}`; plus authorization
  codes (code → pending auth context), plus DCR registered clients. In-memory
  Map for v0.2 (note persistence as follow-up). Include refresh helper that
  re-exchanges the Yandex refresh token and updates the entry.
- `src/auth/provider.ts` — custom `OAuthServerProvider` implementation:
  - `clientsStore`: in-memory DCR store (register/read client).
  - `authorize(client, params, res)`: capture the MCP client's
    `redirectUri`/`state`/`codeChallenge` in the auth-store keyed by an internal
    `loginState`; redirect the user's browser to Yandex's authorize URL with our
    `client_id`, `redirect_uri=<our /auth/yandex/callback>`,
    `scope=cloud:auth tracker:read tracker:write`, `state=<loginState>`.
  - `challengeForAuthorizationCode(client, code)`: return the PKCE
    `codeChallenge` stored when the code was issued (the SDK validates
    `code_verifier` against it).
  - `exchangeAuthorizationCode(client, code, codeVerifier?, redirectUri?, resource?)`:
    mint a new opaque MCP access token (+ refresh), create a store entry that
    references the Yandex token captured during the callback (see callback
    handler), and return `{access_token, refresh_token, expires_in, token_type:"bearer"}`.
  - `exchangeRefreshToken(...)`: rotate the MCP refresh token (and refresh
    Yandex server-side if needed).
  - `verifyAccessToken(token)`: look up the store entry; if the Yandex token is
    near expiry, refresh it; return `AuthInfo` with the resolved Yandex token
    attached (e.g. via a non-standard field or a side store keyed by MCP token —
    the tool layer reads it). Throw on invalid.
- `src/auth/callback.ts` — Yandex callback endpoint `GET /auth/yandex/callback`:
  receive `code`+`state`; exchange the Yandex code server-side (with
  `client_secret`) for a Yandex access+refresh token; store it under the
  `loginState`; then redirect back to resume the MCP authorization (issue an MCP
  authorization code to the MCP client's original `redirectUri`).
- `src/auth/router.ts` — wire `mcpAuthRouter` (from
  `@modelcontextprotocol/sdk/server/auth/router.js`) with our provider,
  `issuerUrl`, `resourceServerUrl`, `scopesSupported`. Mount it on the HTTP
  transport alongside the existing `/mcp`.

### Modify
- `src/transport.ts` (HTTP mode): when OAuth is enabled (env
  `TRACKER_OAUTH_CLIENT_ID`+`TRACKER_OAUTH_CLIENT_SECRET` set), require a valid
  MCP bearer token on `/mcp` (validate via `provider.verifyAccessToken`); on
  missing/invalid return `401` with the `WWW-Authenticate` resource-metadata
  header per RFC9728. Resolve the MCP token → the user's Yandex credential and
  set it via the existing `withCredential` (so tool handlers' `getCredential()`
  works unchanged). Keep the v0.1 per-request-bearer path available when OAuth
  env is NOT set (faust-deployed profile).
- `src/credential.ts`: add a credential source that reads the request-resolved
  Yandex token (set by the auth middleware) — reuses the AsyncLocalStorage path.
- `.env.example` / README: document `TRACKER_OAUTH_CLIENT_ID`,
  `TRACKER_OAUTH_CLIENT_SECRET`, `TRACKER_OAUTH_PUBLIC_URL` (the public base URL
  of this server, used for metadata + Yandex redirect), and that
  `TRACKER_ORG_ID`/`TRACKER_ORG_HEADER` still apply.

### Two PKCE legs (get this right)
- Leg A (MCP client ↔ our AS): the SDK router enforces PKCE; our provider stores
  the `codeChallenge` at authorize and returns it in `challengeForAuthorizationCode`.
- Leg B (our AS ↔ Yandex): our AS is a confidential client (has `client_secret`),
  so PKCE on the Yandex leg is optional — but generate + use it anyway for
  defense-in-depth.

## Deployment note (for README, not code)
The OAuth flow needs tracker-mcp reachable at a public HTTPS URL
(`TRACKER_OAUTH_PUBLIC_URL`) so Yandex can redirect to `/auth/yandex/callback`.
For local dev: a tunnel. Document it.

## Verification (must pass)

1. **Existing tests stay green**: `bun run test` (12/12) and `bun run typecheck`.
2. **New in-process OAuth test** (`tests/auth.test.ts`): drive the full dance
   with an in-process MCP `Client` + our AS router, with the Yandex legs
   (authorize redirect + token exchange + Tracker call) MOCKED:
   - unauthenticated `/mcp` → `401` + `WWW-Authenticate`.
   - client does DCR → authorize → our server redirects to (mocked) Yandex →
     callback exchanges (mocked) → MCP token issued → `/mcp` with MCP token →
     tool call resolves to the (mocked) user's Yandex token → Tracker call
     mocked → success.
   - Assert the MCP client NEVER sees a Yandex token (no passthrough).
3. **No live calls in tests** — all Yandex/Tracker HTTP mocked. Mark the live
   Yandex OAuth round-trip as a manual gate in the README (deployer runs it once
   with real `client_id`/`secret`).

## Out of scope (do not implement)
- faust-deployed profile changes (per-request-bearer already works).
- calendar / mail / wiki MCP packages.
- Hosted/shared-app model.
- Persistent token store (in-memory for v0.2; note follow-up).
- `tracker-mcp setup` guided helper (separate task).

## Done when
- `bun run typecheck` + `bun run test` (existing 12 + new auth tests) green.
- An in-process client completes the OAuth dance end-to-end (mocked Yandex) and
  calls a tool, with the no-passthrough assertion holding.
- README documents the OAuth env vars + the public-URL/tunnel requirement +
  the manual live-Yandex gate.
- Commit on the repo's `master` (the OSS repo, not faust) with clear messages.
