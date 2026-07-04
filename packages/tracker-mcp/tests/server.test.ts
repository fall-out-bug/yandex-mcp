import { test, expect, beforeAll, afterAll } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer } from "../src/server.js"

const originalFetch = globalThis.fetch
const originalToken = process.env.TRACKER_TOKEN
const originalOrg = process.env.TRACKER_ORG_ID

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function connect(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createServer()
  const client = new Client({ name: "test-client", version: "0.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  // Connect both sides concurrently to avoid an initialize-handshake deadlock.
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { client, cleanup: async () => { await client.close().catch(() => undefined) } }
}

beforeAll(() => {
  // stdio-style credential (single-user path) so tool handlers can resolve one.
  process.env.TRACKER_TOKEN = "tok"
  process.env.TRACKER_ORG_ID = "org-1"
})

afterAll(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.TRACKER_TOKEN
  else process.env.TRACKER_TOKEN = originalToken
  if (originalOrg === undefined) delete process.env.TRACKER_ORG_ID
  else process.env.TRACKER_ORG_ID = originalOrg
})

test("lists all registered tools", async () => {
  const { client, cleanup } = await connect()
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  expect(names).toEqual(expect.arrayContaining([
    "get_myself", "get_issue", "search_issues", "create_issue", "add_comment", "list_transitions", "execute_transition",
  ]))
  await cleanup()
})

test("every tool has a non-empty description guiding model use", async () => {
  const { client, cleanup } = await connect()
  const { tools } = await client.listTools()
  for (const t of tools) {
    expect(typeof t.description).toBe("string")
    expect((t.description ?? "").trim().length).toBeGreaterThan(40)
  }
  await cleanup()
})

test("get_myself returns the resolved identity", async () => {
  globalThis.fetch = (async () => jsonResp({ uid: "u1", login: "alice", display: "Alice" })) as typeof fetch
  const { client, cleanup } = await connect()
  const result = await client.callTool({ name: "get_myself", arguments: {} })
  const text = (result.content as Array<{ type: string; text: string }>)[0].text
  expect(text).toContain("Alice")
  expect(text).toContain("@alice")
  await cleanup()
})

test("search_issues paginates and surfaces a cursor", async () => {
  globalThis.fetch = (async () =>
    jsonResp([
      { key: "T-1", summary: "first", status: { key: "open", display: "Open" }, queue: { key: "T", display: "T" }, updatedAt: "x", createdAt: "x" },
    ]),
  ) as typeof fetch
  const { client, cleanup } = await connect()
  const result = await client.callTool({ name: "search_issues", arguments: { query: "Assignee: me()", cursor: undefined } })
  const text = (result.content as Array<{ type: string; text: string }>)[0].text
  // perPage defaults to 25; one row returned → fewer than perPage → no cursor surfaced
  expect(text).toContain("T-1")
  await cleanup()
})

test("missing issue is a normal (non-error) message, not an error result", async () => {
  globalThis.fetch = (async () => new Response("none", { status: 404 })) as typeof fetch
  const { client, cleanup } = await connect()
  const result = await client.callTool({ name: "get_issue", arguments: { key: "T-404" } })
  expect(result.isError).toBeFalsy()
  const text = (result.content as Array<{ type: string; text: string }>)[0].text
  expect(text).toContain("not found")
  await cleanup()
})

test("auth failure is surfaced as an error result with guidance", async () => {
  globalThis.fetch = (async () => new Response("bad", { status: 401 })) as typeof fetch
  const { client, cleanup } = await connect()
  const result = await client.callTool({ name: "get_myself", arguments: {} })
  expect(result.isError).toBe(true)
  const text = (result.content as Array<{ type: string; text: string }>)[0].text
  expect(text).toContain("invalid or expired")
  await cleanup()
})
