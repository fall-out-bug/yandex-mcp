# Archived — superseded by aikts/yandex-tracker-mcp

**This repository is archived.** Do not use it.

After reading the code of existing Yandex Tracker MCP servers (not just their
READMEs), we found **[aikts/yandex-tracker-mcp](https://github.com/aikts/yandex-tracker-mcp)**
is a mature superset of everything built here:

- **Standalone per-user OAuth profile** — the same MCP-SDK `OAuthAuthorizationServerProvider`
  architecture (authorize → Yandex, callback, server-side code exchange, no token
  passthrough, refresh+rotation+revoke, DCR, RFC 8707), with redis/memory/encrypted
  stores. (Our `packages/tracker-mcp/src/auth/*` was a less-mature duplicate.)
- **Gateway / reverse-proxy Bearer passthrough** — reads a per-user Yandex token
  from `Authorization: Bearer` for deployments where a gateway (e.g. Faust) holds
  the tokens. Same as our v0.1 HTTP bearer mode.
- Plus IAM tokens, service-account auth, both `X-Org-ID` / `X-Cloud-Org-ID`,
  caching, a wide tool surface, elicitation confirmations.
- **Apache-2.0, Python** (Python is also the language of our agent runtime, Gena).

Per the decision gate (reuse established OSS rather than maintain a duplicate),
we adopt aikts and retire this repo.

## What carries over (verified here, still valid for aikts)

These facts were verified while building this repo and apply equally to aikts /
Tracker v3:

- Tracker OAuth scopes: **`cloud:auth` + `tracker:read` + `tracker:write`**
  (`cloud:auth` is the one that unblocks Cloud-org access; without it Tracker
  returns 401 even with the tracker scopes).
- Cloud-org auth: `Authorization: OAuth <token>` + `X-Cloud-Org-Id: <org-id>`
  — **direct OAuth, no IAM exchange** (the OAuth→IAM exchange is dead for
  federated Cloud users on tokens issued after 2026-06-01).
- Tracker v3 search body is top-level `{query}`; `perPage`/`page` are query params.

## Reusable dev helpers (not server-specific)

These three scripts in this repo work for **any** Yandex Tracker OAuth setup:

- `scripts/fetch-token.ts` — local OAuth code-flow helper to obtain a Tracker
  access token (run the dance once).
- `scripts/discover-org.ts` — non-admin Cloud-org id discovery via IAM.
- `packages/tracker-mcp/scripts/live-probe.ts` — spawn any stdio Tracker MCP and
  call `get_myself` / `search_issues` live to verify it works.

Keep them as references; they are not published as a package.
