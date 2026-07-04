#!/usr/bin/env node
/**
 * Entry point. Transport is chosen via MCP_TRANSPORT (or argv):
 *   - stdio (default): single-user mode; credential from TRACKER_TOKEN + TRACKER_ORG_ID env.
 *   - http           : multi-user / server-runtime mode; each request carries
 *                      Authorization + X-Org-ID headers (the user's own scope).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createServer } from "./server.js"
import { readEnvCredential } from "./credential.js"
import { runStdio, runHttp } from "./transport.js"

async function main(): Promise<void> {
  const transport = (process.env.MCP_TRANSPORT ?? (process.argv[2] === "http" ? "http" : "stdio")).toLowerCase()

  if (transport === "http") {
    await runHttp(createServer)
    return
  }

  // stdio (default)
  const envCred = readEnvCredential()
  if (!envCred) {
    process.stderr.write(
      "[tracker-mcp] stdio mode requires TRACKER_TOKEN and TRACKER_ORG_ID env vars. See .env.example.\n",
    )
  }
  await runStdio(createServer(), new StdioServerTransport())
}

main().catch((err) => {
  process.stderr.write(`[tracker-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
