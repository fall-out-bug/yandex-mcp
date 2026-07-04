/**
 * Live probe: spawn tracker-mcp (stdio) with a REAL Yandex token and call tools
 * against the LIVE Tracker API. Proves the MCP -> Tracker path end-to-end.
 *
 * Run from the package dir with your token in env (do NOT paste tokens into chat):
 *   cd packages/tracker-mcp
 *   TRACKER_TOKEN='<your access token>' bun run ../../scripts/live-probe.ts
 *
 * Optional env: TRACKER_ORG_ID (default bpfd8mfc069c147a91r9),
 *               TRACKER_ORG_HEADER (default X-Cloud-Org-Id),
 *               TRACKER_SEARCH (default "Assignee: me() Resolution: Empty()").
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const token = process.env.TRACKER_TOKEN
if (!token) {
  console.error("Set TRACKER_TOKEN env var (your Yandex OAuth access token).")
  process.exit(1)
}
const orgId = process.env.TRACKER_ORG_ID ?? "bpfd8mfc069c147a91r9"
const orgHeader = process.env.TRACKER_ORG_HEADER ?? "X-Cloud-Org-Id"
const search = process.env.TRACKER_SEARCH ?? "Assignee: me() Resolution: Empty()"

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: new URL("../packages/tracker-mcp/", import.meta.url).pathname,
  env: { ...process.env, TRACKER_TOKEN: token, TRACKER_ORG_ID: orgId, TRACKER_ORG_HEADER: orgHeader },
})

const client = new Client({ name: "live-probe", version: "0.0.0" })
await client.connect(transport)

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.map((c) => c.text ?? "").join("\n") ?? "(no text)"
}

console.log("=== get_myself ===")
const me = await client.callTool({ name: "get_myself", arguments: {} })
console.log(textOf(me as { content: Array<{ type: string; text?: string }> }))

console.log("\n=== search_issues: " + search + " ===")
const found = await client.callTool({ name: "search_issues", arguments: { query: search } })
console.log(textOf(found as { content: Array<{ type: string; text?: string }> }))

await client.close()
