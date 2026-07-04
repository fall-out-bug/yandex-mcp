import { afterEach, test, expect } from "bun:test"
import { TrackerClient } from "../src/client.js"
import { TrackerError } from "../src/errors.js"

const originalFetch = globalThis.fetch

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

const cred = { token: "tok", orgId: "org-1", orgHeader: "X-Org-ID" as const, baseUrl: "https://api.tracker.yandex.net/v3", authScheme: "OAuth" as const }

test("getMyself maps identity", async () => {
  globalThis.fetch = (async () => jsonResp({ uid: "u1", login: "alice", display: "Alice", email: "a@x" })) as typeof fetch
  const me = await new TrackerClient(cred).getMyself()
  expect(me).toEqual({ uid: "u1", login: "alice", display: "Alice", email: "a@x" })
})

test("searchIssues posts top-level {query} to v3 with perPage/page query params", async () => {
  let capturedUrl = ""
  let capturedBody: unknown
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input)
    capturedBody = init?.body ? JSON.parse(init.body as string) : undefined
    return jsonResp([{ key: "T-1", summary: "s", status: { key: "open", display: "Open" }, queue: { key: "T", display: "T" }, updatedAt: "x", createdAt: "x" }])
  }) as typeof fetch
  const page = await new TrackerClient(cred).searchIssues("Assignee: me()", { perPage: 1 })
  expect(capturedUrl.startsWith("https://api.tracker.yandex.net/v3/issues/_search?perPage=1&page=1")).toBe(true)
  expect(capturedBody).toEqual({ query: "Assignee: me()" })
  // one result == perPage → nextCursor present
  expect(page.nextCursor).not.toBeNull()
})

test("searchIssues returns null cursor when fewer than perPage", async () => {
  globalThis.fetch = (async () => jsonResp([])) as typeof fetch
  const page = await new TrackerClient(cred).searchIssues("q", { perPage: 25 })
  expect(page.issues).toEqual([])
  expect(page.nextCursor).toBeNull()
})

test("getIssue returns null on 404", async () => {
  globalThis.fetch = (async () => new Response("none", { status: 404 })) as typeof fetch
  const issue = await new TrackerClient(cred).getIssue("T-999")
  expect(issue).toBeNull()
})

test("401 is translated to an auth TrackerError with guidance", async () => {
  globalThis.fetch = (async () => new Response("bad token", { status: 401 })) as typeof fetch
  try {
    await new TrackerClient(cred).getMyself()
    throw new Error("should have thrown")
  } catch (err) {
    expect(err).toBeInstanceOf(TrackerError)
    expect((err as TrackerError).kind).toBe("auth")
    expect((err as TrackerError).message).toContain("invalid or expired")
  }
})

test("429 is translated to rate_limited", async () => {
  globalThis.fetch = (async () => new Response("slow down", { status: 429 })) as typeof fetch
  try {
    await new TrackerClient(cred).getIssue("T-1")
    throw new Error("should have thrown")
  } catch (err) {
    expect((err as TrackerError).kind).toBe("rate_limited")
  }
})
