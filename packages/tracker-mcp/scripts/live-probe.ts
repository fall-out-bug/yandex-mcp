/**
 * Live probe: spawn tracker-mcp (stdio) with a REAL Yandex token and call tools
 * against the LIVE Tracker API. Proves the MCP -> Tracker path end-to-end.
 *
 * Run from the package dir with your token in env (do NOT paste tokens into chat):
 *   cd packages/tracker-mcp
 *   TRACKER_TOKEN='<your access token>' bun run scripts/live-probe.ts
 *
 * Optional env: TRACKER_ORG_ID (default bpfd8mfc069c147a91r9),
 *               TRACKER_ORG_HEADER (default X-Cloud-Org-Id),
 *               TRACKER_SEARCH (default "Assignee: me() Resolution: Empty()").
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { existsSync } from "node:fs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(__dirname, "..") // packages/tracker-mcp
const serverEntry = resolve(pkgDir, "dist/index.js")
if (!existsSync(serverEntry)) {
  console.error(`Server not built: ${serverEntry} missing. Run 'bun run build' here.`)
  process.exit(1)
}

const token = process.env.TRACKER_TOKEN
if (!token) {
  console.error("Set TRACKER_TOKEN env var (your Yandex OAuth access token).")
  process.exit(1)
}
const orgId = process.env.TRACKER_ORG_ID ?? "bpfd8mfc069c147a91r9"
const orgHeader = process.env.TRACKER_ORG_HEADER ?? "X-Cloud-Org-Id"
const search = process.env.TRACKER_SEARCH ?? "Assignee: me()"

const watchdog = setTimeout(() => {
  console.error("\n[probe] timed out after 25s")
  process.exit(2)
}, 25_000)
watchdog.unref?.()

const transport = new StdioClientTransport({
  command: "node",
  args: [serverEntry],
  cwd: pkgDir,
  env: { ...process.env, TRACKER_TOKEN: token, TRACKER_ORG_ID: orgId, TRACKER_ORG_HEADER: orgHeader },
})

const client = new Client({ name: "live-probe", version: "0.0.0" })

function textOf(result: unknown): string {
  const c = (result as { content?: Array<{ type: string; text?: string }> }).content
  return c?.map((p) => p.text ?? "").join("\n") ?? "(no text)"
}

try {
  await client.connect(transport)
  console.log("=== get_myself ===")
  const me = await client.callTool({ name: "get_myself", arguments: {} })
  console.log(textOf(me))
  console.log("\n=== search_issues: " + search + " ===")
  const found = await client.callTool({ name: "search_issues", arguments: { query: search } })
  console.log(textOf(found))
} catch (err) {
  console.error("[probe] error:", err instanceof Error ? err.message : String(err))
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await client.close().catch(() => undefined)
  process.exit(0)
}
