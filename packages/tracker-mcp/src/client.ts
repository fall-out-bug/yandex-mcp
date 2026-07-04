/**
 * Yandex Tracker REST API v3 client.
 *
 * Reference: https://yandex.ru/support/tracker/en/api-ref/about-api
 * Auth per call: Authorization: OAuth <token> + X-Org-ID (or X-Cloud-Org-ID).
 *
 * The client is stateless and takes a credential per instance — it never reads
 * env or stores tokens itself. Pagination uses an opaque cursor.
 */
import { TrackerError, errorFromResponse, networkError } from "./errors.js"
import type { TrackerCredential } from "./credential.js"

export type Issue = {
  key: string
  summary: string
  description?: string
  status: { key: string; display: string }
  assignee?: { id: string; display: string }
  queue: { key: string; display: string }
  deadline?: string
  updatedAt: string
  createdAt: string
  type?: { key: string; display: string }
  priority?: { key: string; display: string }
}

export type Myself = {
  uid: string
  login?: string
  display: string
  email?: string
}

export type Transition = {
  id: string
  to: { key: string; display: string }
}

export type Comment = {
  id: string
  text: string
  createdAt?: string
  createdBy?: { display: string }
}

export type SearchPage = {
  issues: Issue[]
  /** Opaque cursor for the next page, or null if no more results. */
  nextCursor: string | null
}

type CursorPayload = { query: string; perPage: number; page: number }

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url")
}

function decodeCursor(cursor: string): CursorPayload {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload
}

function pickIssue(raw: Record<string, unknown>): Issue {
  const status = (raw.status ?? {}) as Record<string, unknown>
  const assignee = (raw.assignee ?? {}) as Record<string, unknown>
  const queue = (raw.queue ?? {}) as Record<string, unknown>
  const type = (raw.type ?? {}) as Record<string, unknown>
  const priority = (raw.priority ?? {}) as Record<string, unknown>
  return {
    key: String(raw.key ?? ""),
    summary: String(raw.summary ?? ""),
    description: raw.description != null ? String(raw.description) : undefined,
    status: { key: String(status.key ?? ""), display: String(status.display ?? "") },
    assignee: raw.assignee ? { id: String(assignee.id ?? ""), display: String(assignee.display ?? "") } : undefined,
    queue: { key: String(queue.key ?? ""), display: String(queue.display ?? "") },
    deadline: raw.deadline != null ? String(raw.deadline) : undefined,
    updatedAt: String(raw.updatedAt ?? ""),
    createdAt: String(raw.createdAt ?? ""),
    type: raw.type ? { key: String(type.key ?? ""), display: String(type.display ?? "") } : undefined,
    priority: raw.priority ? { key: String(priority.key ?? ""), display: String(priority.display ?? "") } : undefined,
  }
}

export class TrackerClient {
  constructor(private readonly cred: TrackerCredential) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `${this.cred.authScheme} ${this.cred.token}`,
      [this.cred.orgHeader]: this.cred.orgId,
      "Content-Type": "application/json",
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const qs = query ? "?" + new URLSearchParams(query).toString() : ""
    const url = `${this.cred.baseUrl}${path}${qs}`
    try {
      const resp = await fetch(url, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const text = await resp.text()
      if (!resp.ok) throw await errorFromResponse(resp, text)
      return text ? (JSON.parse(text) as T) : (undefined as unknown as T)
    } catch (err) {
      if (err instanceof TrackerError) throw err
      throw networkError(err)
    }
  }

  async getMyself(): Promise<Myself> {
    const raw = await this.request<Record<string, unknown>>("GET", "/myself")
    return {
      uid: String(raw.uid ?? raw.id ?? ""),
      login: raw.login != null ? String(raw.login) : undefined,
      display: String(raw.display ?? raw.login ?? ""),
      email: raw.email != null ? String(raw.email) : undefined,
    }
  }

  async getIssue(key: string): Promise<Issue | null> {
    try {
      const raw = await this.request<Record<string, unknown>>("GET", `/issues/${encodeURIComponent(key)}`)
      return pickIssue(raw)
    } catch (err) {
      if (err instanceof TrackerError && err.kind === "not_found") return null
      throw err
    }
  }

  async searchIssues(query: string, opts?: { perPage?: number; page?: number }): Promise<SearchPage> {
    const perPage = Math.min(opts?.perPage ?? 25, 100)
    const page = opts?.page ?? 1
    const raw = await this.request<unknown[]>("POST", "/issues/_search", { query }, { perPage: String(perPage), page: String(page) })
    const issues = Array.isArray(raw) ? raw.map((r) => pickIssue(r as Record<string, unknown>)) : []
    const total = issues.length
    const nextCursor = total === perPage ? encodeCursor({ query, perPage, page: page + 1 }) : null
    return { issues, nextCursor }
  }

  /** Resume a search from an opaque cursor returned by {@link searchIssues}. */
  async searchIssuesByCursor(cursor: string): Promise<SearchPage> {
    const { query, perPage, page } = decodeCursor(cursor)
    return this.searchIssues(query, { perPage, page })
  }

  async createIssue(input: {
    queue: string
    summary: string
    description?: string
    assignee?: string
    deadline?: string
    type?: string
  }): Promise<Issue> {
    const body: Record<string, unknown> = { queue: input.queue, summary: input.summary }
    if (input.description != null) body.description = input.description
    if (input.assignee != null) body.assignee = input.assignee
    if (input.deadline != null) body.deadline = input.deadline
    if (input.type != null) body.type = input.type
    const raw = await this.request<Record<string, unknown>>("POST", "/issues", body)
    return pickIssue(raw)
  }

  async addComment(key: string, text: string): Promise<Comment> {
    const raw = await this.request<Record<string, unknown>>("POST", `/issues/${encodeURIComponent(key)}/comments`, { text })
    const createdBy = (raw.createdBy ?? {}) as Record<string, unknown>
    return {
      id: String(raw.id ?? raw.longId ?? ""),
      text: String(raw.text ?? text),
      createdAt: raw.createdAt != null ? String(raw.createdAt) : undefined,
      createdBy: raw.createdBy ? { display: String(createdBy.display ?? "") } : undefined,
    }
  }

  async listTransitions(key: string): Promise<Transition[]> {
    const raw = await this.request<unknown[]>("GET", `/issues/${encodeURIComponent(key)}/transitions`)
    if (!Array.isArray(raw)) return []
    return raw.map((t) => {
      const obj = t as Record<string, unknown>
      const to = (obj.to ?? {}) as Record<string, unknown>
      return { id: String(obj.id ?? ""), to: { key: String(to.key ?? ""), display: String(to.display ?? "") } }
    })
  }

  async executeTransition(key: string, transitionId: string, comment?: string): Promise<Issue> {
    const body: Record<string, unknown> = {}
    if (comment) body.comment = comment
    // Tracker returns the updated issue for a transition POST.
    const raw = await this.request<Record<string, unknown>>(
      "POST",
      `/issues/${encodeURIComponent(key)}/transitions/${encodeURIComponent(transitionId)}`,
      Object.keys(body).length ? body : {},
    )
    return pickIssue(raw)
  }
}
