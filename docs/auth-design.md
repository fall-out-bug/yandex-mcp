# tracker-mcp Authorization Design (research brief)

Status: brief, 2026-07-04. Decides how tracker-mcp becomes a Vercel-style
"connect → authorize → use" MCP server (no baked tokens).

## The mandate: tracker-mcp must be an OAuth 2.1 proxy/auth-server

From the MCP Authorization spec (2025-06-18, verified) — one rule dominates:

> **Token passthrough is forbidden.** "If the MCP server makes requests to
> upstream APIs, it may act as an OAuth client to them. The access token used at
> the upstream API is a separate token… The MCP server MUST NOT pass through the
> token it received from the MCP client."

So tracker-mcp cannot forward the host's token to Yandex. It must:

1. Act as an **OAuth 2.1 resource server** to the MCP host: validate the host's
   bearer token, return `401 + WWW-Authenticate` when missing.
2. Host its **own authorization server** (AS): issue its OWN MCP access tokens,
   expose `/.well-known/oauth-authorization-server` (RFC8414).
3. Expose `/.well-known/oauth-protected-resource` (RFC9728) pointing to the AS.
4. Act as an **OAuth client to Yandex** (upstream): run Yandex's authorization
   code flow using the **deployer's** OAuth app (`client_id`/`secret`, external),
   store the resulting Yandex token, and map it to the MCP session/token.
5. Tool calls: host presents MCP token → tracker-mcp maps to Yandex token →
   calls Tracker (`OAuth` + `X-Cloud-Org-Id`). The Yandex token never leaves
   tracker-mcp.

This is the standard "MCP proxy server" pattern the spec explicitly addresses
(confused-deputy, consent for DCR clients). It makes tracker-mcp stateful
(MCP-session → Yandex-token store), like Vercel/GitHub MCPs.

### Spec requirements checklist
- [ ] Protected Resource Metadata `/.well-known/oauth-protected-resource` (RFC9728), with `authorization_servers`.
- [ ] `401` + `WWW-Authenticate` header on unauthenticated requests.
- [ ] Authorization Server Metadata `/.well-known/oauth-authorization-server` (RFC8414).
- [ ] Authorization Code flow + **PKCE** (client↔our AS).
- [ ] Dynamic Client Registration `/register` (RFC7591) — SHOULD; our AS implements it.
- [ ] `resource` parameter (RFC8707) + token **audience** validation (tokens issued for THIS MCP server only).
- [ ] Short-lived MCP access tokens + refresh rotation.
- [ ] HTTPS everywhere; redirect URIs localhost or HTTPS.

## SDK support (verified)

`@modelcontextprotocol/sdk` v1.29 ships `server/auth/`: `provider`, `router`,
`middleware`, `providers/` (pluggable), `clients`, `errors`, `types`. So the
OAuth AS scaffolding is provided — we implement a **provider** that bridges to
Yandex, not the protocol plumbing from scratch.

## Yandex bridge feasibility (verified, low risk)

- Our AS ↔ Yandex: authorization **code flow** with the deployer's
  `client_id`/`secret` (confidential client → PKCE-on-Yandex not required).
- Scopes: **`cloud:auth tracker:read tracker:write`** (`cloud:auth` is the one
  that unblocks Cloud-org access).
- Resulting Yandex token works **directly**: `OAuth <token>` + `X-Cloud-Org-Id`
  (proven live, no IAM exchange — and IAM exchange is dead for federated Cloud
  users anyway).
- Yandex lacks DCR and `.well-known` — **fine**: our AS implements those for the
  host; our AS talks to Yandex via hardcoded/configured endpoints with the
  static client_id.

## Host support (verified)

OpenCode implements the MCP client OAuth flow (`opencode mcp auth <server>`).
So the "connect → authorize → use" UX works in the user's actual host. Also
works in Claude Desktop, Cursor, and other spec-compliant clients.

## Two deployment profiles (same server)

1. **Standalone / community** (the Vercel-style one): tracker-mcp runs its own
   OAuth AS + token store. Deployer provides Yandex `client_id`/`secret` +
   public callback URL. Each connecting user authorizes → per-user Yandex token.
2. **Faust-deployed**: faust already holds per-user Yandex tokens (its own OAuth
   connect); tracker-mcp runs as a thin HTTP resource server validating
   faust-issued bearer tokens (the v0.1 per-request-bearer mode). No double
   OAuth.

## Deployment constraint

The standalone OAuth flow needs tracker-mcp reachable over **HTTPS with a public
callback URL** (Yandex redirect + MCP host callbacks). For local dev: a tunnel
(ngrok/cloudflare). The faust-deployed profile runs inside the existing
`gennady.beetles.family` infra.

## Open questions / risks

1. **Token store**: in-memory (lost on restart) vs persistent. For community
   single-instance: a small encrypted file/DB. Scope for v0.2.
2. **Yandex PKCE**: confirm Yandex code flow works WITHOUT PKCE from our AS
   (confidential client) — expected yes, verify at integration.
3. **Refresh**: Yandex access tokens expire; our AS must refresh using the stored
   Yandex refresh token, re-mapping to the MCP session.
4. **Callback URL per deploy**: the deployer's Yandex app must register the
   tracker-mcp callback; documented in README.

## Phase plan

- **Auth-1**: Protected Resource Metadata + `401/WWW-Authenticate` + AS metadata
  + code/PKCE + DCR, issuing own MCP tokens (token store: in-memory). Validate
  with a spec-compliant client end-to-end (the OAuth dance completes).
- **Auth-2**: wire the AS to Yandex (deployer client_id/secret, code flow,
  cloud:auth scope) + store Yandex token + map to MCP session + refresh.
- **Auth-3**: tool calls resolve MCP token → Yandex token → Tracker; replace the
  v0.1 env/header credential paths for the standalone profile (keep them for
  faust-deployed).
- Tests: the OAuth dance is testable in-process (MCP client + our AS); the
  Yandex leg is fixture + live-gated.
