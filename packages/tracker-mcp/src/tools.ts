/**
 * Tool registration for the Tracker MCP server.
 *
 * Design for the model, not the API: a handful of deep tools with descriptions
 * that tell an LLM when to use them, required fields, and quirks. Outputs are
 * trimmed to decision-ready fields.
 */
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { TrackerClient, type Issue } from "./client.js"
import { getCredential } from "./credential.js"
import { TrackerError } from "./errors.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] }
}

function fail(err: TrackerError): ToolResult {
  return { content: [{ type: "text", text: err.message }], isError: true }
}

function client(): TrackerClient {
  return new TrackerClient(getCredential())
}

function issueLine(i: Issue): string {
  const who = i.assignee ? ` • assignee: ${i.assignee.display}` : " • unassigned"
  const dl = i.deadline ? ` • deadline: ${i.deadline}` : ""
  const st = i.status.display || i.status.key
  return `- [${i.key}](${webLink(i)}) ${i.summary} — ${st}${who}${dl} (queue: ${i.queue.key})`
}

function webLink(i: Issue): string {
  return `https://tracker.yandex.ru/${i.key}`
}

export function registerTools(server: McpServer): void {
  server.tool(
    "get_myself",
    "Return the Tracker identity of the current user (the owner of the presented credential). Use this first to confirm the token and org id are valid and to see who you are acting as. No parameters.",
    {},
    async () => {
      try {
        const me = await client().getMyself()
        return text(`Authenticated as: ${me.display}${me.login ? ` (@${me.login})` : ""}${me.email ? ` <${me.email}>` : ""} — uid: ${me.uid}`)
      } catch (e) {
        return e instanceof TrackerError ? fail(e) : fail(new TrackerError("unknown", String(e)))
      }
    },
  )

  server.tool(
    "get_issue",
    "Fetch a single Tracker issue by its key (e.g. 'MYQUEUE-42'). Use when the user mentions a specific ticket. Returns the key, summary, status, assignee, deadline, queue, and a web link. Returns a clear message if the issue is missing or outside this user's scope.",
    { key: z.string().describe("Issue key, e.g. 'MYQUEUE-42'") },
    async ({ key }) => {
      try {
        const issue = await client().getIssue(key)
        if (!issue) return text(`Issue ${key} not found (or outside this user's scope).`)
        return text(issueLine(issue))
      } catch (e) {
        return e instanceof TrackerError ? fail(e) : fail(new TrackerError("unknown", String(e)))
      }
    },
  )

  server.tool(
    "search_issues",
    "Search Tracker issues using the Tracker query language (the same syntax as the Tracker UI search), e.g. 'Queue: MYQUEUE Assignee: me() Resolution: Empty()'. Use for any 'find/show/list my tasks' intent. Results are paginated with an opaque cursor — if a next cursor is returned, call again with cursor to continue. Do not invent query syntax.",
    {
      query: z.string().describe("Tracker query language string, e.g. 'Assignee: me() Resolution: Empty()'"),
      cursor: z.string().optional().describe("Opaque cursor returned by a previous search_issues call to fetch the next page"),
    },
    async ({ query, cursor }) => {
      try {
        const c = client()
        const page = cursor ? await c.searchIssuesByCursor(cursor) : await c.searchIssues(query)
        const head = page.issues.length
          ? `Found ${page.issues.length} issues${page.nextCursor ? " (more available — pass the cursor to continue)" : ""}:`
          : "No issues matched this query."
        const body = page.issues.map(issueLine).join("\n")
        const tail = page.nextCursor ? `\n\ncursor: ${page.nextCursor}` : ""
        return text([head, body, tail].filter(Boolean).join("\n"))
      } catch (e) {
        return e instanceof TrackerError ? fail(e) : fail(new TrackerError("unknown", String(e)))
      }
    },
  )

  server.tool(
    "create_issue",
    "Create a new Tracker issue. Requires a queue key and a summary. Optionally set description, assignee (login), deadline (YYYY-MM-DD), and type (e.g. 'task', 'bug'). This is a write — only do it when the user clearly asks to create a task. Returns the created issue's key and a web link.",
    {
      queue: z.string().describe("Destination queue key, e.g. 'MYQUEUE'"),
      summary: z.string().describe("Issue title"),
      description: z.string().optional().describe("Issue description (optional)"),
      assignee: z.string().optional().describe("Assignee login (optional)"),
      deadline: z.string().optional().describe("Deadline, YYYY-MM-DD (optional)"),
      type: z.string().optional().describe("Issue type key, e.g. 'task' or 'bug' (optional)"),
    },
    async (input) => {
      try {
        const issue = await client().createIssue(input)
        return text(`Created ${issueLine(issue)}`)
      } catch (e) {
        return e instanceof TrackerError ? fail(e) : fail(new TrackerError("unknown", String(e)))
      }
    },
  )

  server.tool(
    "add_comment",
    "Add a comment to a Tracker issue. Use when the user wants to note or reply on an existing ticket. Requires the issue key and the comment text. Returns a confirmation.",
    {
      key: z.string().describe("Issue key, e.g. 'MYQUEUE-42'"),
      text: z.string().describe("Comment body"),
    },
    async ({ key, text: commentText }) => {
      try {
        const comment = await client().addComment(key, commentText)
        return text(`Comment added to ${key}${comment.createdAt ? ` at ${comment.createdAt}` : ""}.`)
      } catch (e) {
        return e instanceof TrackerError ? fail(e) : fail(new TrackerError("unknown", String(e)))
      }
    },
  )

  server.tool(
    "list_transitions",
    "List the status transitions available to the current user on an issue (e.g. 'close', 'in_progress'). Always call this before execute_transition to get the exact transition id — the set of allowed transitions depends on the issue's current status and the user's rights.",
    { key: z.string().describe("Issue key, e.g. 'MYQUEUE-42'") },
    async ({ key }) => {
      try {
        const transitions = await client().listTransitions(key)
        if (!transitions.length) return text(`No transitions are available for ${key} (it may be terminal, or the user lacks rights).`)
        const body = transitions.map((t) => `- ${t.id} -> ${t.to.display || t.to.key}`).join("\n")
        return text(`Available transitions for ${key}:\n${body}`)
      } catch (e) {
        return e instanceof TrackerError ? fail(e) : fail(new TrackerError("unknown", String(e)))
      }
    },
  )

  server.tool(
    "execute_transition",
    "Move an issue to a new status by executing a transition (e.g. close, reopen). You MUST obtain the transition id from list_transitions first. Optionally add a comment with the transition. This is a write — only do it when the user clearly asks to change status or close a ticket.",
    {
      key: z.string().describe("Issue key, e.g. 'MYQUEUE-42'"),
      transition_id: z.string().describe("Transition id from list_transitions"),
      comment: z.string().optional().describe("Optional comment attached to the transition"),
    },
    async ({ key, transition_id, comment }) => {
      try {
        const issue = await client().executeTransition(key, transition_id, comment)
        return text(`Transition applied to ${issueLine(issue)}`)
      } catch (e) {
        return e instanceof TrackerError ? fail(e) : fail(new TrackerError("unknown", String(e)))
      }
    },
  )
}
