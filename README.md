# yandex-mcp

Per-user-credential MCP servers for Yandex services. Each package is a standalone
[Model Context Protocol](https://modelcontextprotocol.io/) server that lets an
LLM agent act **within a single user's scope** — the credential presented per call
defines what the agent can see, never a shared org-wide token.

> Status: `packages/tracker-mcp` is the first server (Yandex Tracker v3). Calendar
> and Mail will follow the same pattern, sharing a core extracted at that point.

## Why another Yandex MCP?

Existing Yandex Tracker MCP servers take **one** org-wide token (`tracker:read`
+ `tracker:write`) and expose everything that token can see. That is fine for a
single developer but wrong for an organization: one credential must not gate
everyone's data.

This project inverts that: **the user's scope is the user's own credential.**
The server is a stateless resource layer — it stores no tokens, refreshes
nothing, and creates no OAuth apps. A product layer (your app, or Faust) obtains
per-user tokens and hands them to the server per call.

## Packages

| Package | Service | Status |
| --- | --- | --- |
| [`packages/tracker-mcp`](./packages/tracker-mcp) | Yandex Tracker (v3 API) | usable |

## Transports & credentials

- **stdio + env** — single-user mode for local clients (Claude Desktop, Cursor):
  `TRACKER_TOKEN`, `TRACKER_ORG_ID`, …
- **Streamable HTTP + per-request bearer** — multi-user / server-runtime mode:
  each request carries `Authorization: OAuth <user-token>` + `X-Org-ID`. This is
  the org-safe mode and the reason this project exists.

See a package's README for setup.

## Safety boundary

This server is **not** a safety boundary. It faithfully executes Tracker
operations inside the presented user scope. Confirmation gates, product-level
audit, and rate budgets belong to the calling product, not this server.

## License

MIT.
