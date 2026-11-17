import type { WrapperConfig } from "./config.ts"
import {
  issueIdSchema,
  issueUpdateSchema,
  type IssueUpdate,
} from "./issue-update.ts"
import { withIssueUpdate } from "./upstream-deadline.ts"
import { TokenPermissions, scopeAlternatives } from "./token-permissions.ts"
import {
  appendQuery,
  assertConfiguredScope,
  type ApiQuery,
  validateApiPath,
  validateQuery,
} from "./security/validate-api-path.ts"
import {
  redactValue,
  redactText,
  redactErrorMessage,
} from "./security/redact.ts"

export interface PaginationMetadata {
  hasNext: boolean
  nextCursor?: string
  nextPath?: string
}

export interface ApiResponse {
  status: number
  contentType?: string
  request: {
    method: "GET" | "HEAD" | "OPTIONS" | "PUT" | "POST" | "DELETE"
    path: string
  }
  pagination: PaginationMetadata | null
  truncated: boolean
  headers: Record<string, string>
  body: unknown
}

interface RequestOptions {
  method?: "GET" | "HEAD" | "OPTIONS" | "PUT" | "POST" | "DELETE"
  body?: string
  authenticate?: boolean
  requireApiPath?: boolean
  enforceScope?: boolean
  timeoutMs?: number
  maxResponseBytes?: number
}

const MAX_REDIRECTS = 3

export class SentryApiError extends Error {
  constructor(
    message: string,
    readonly code:
      | "timeout"
      | "network"
      | "response-too-large"
      | "unsupported-content"
      | "redirect"
      | "scope",
  ) {
    super(message)
    this.name = "SentryApiError"
  }
}

function headerSubset(
  response: Response,
  accessToken: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of ["retry-after", "x-sentry-error"]) {
    const value = response.headers.get(name)
    if (value) {
      result[name] = redactText(value.slice(0, 1_024), accessToken)
    }
  }
  return result
}

function queryFromParams(params: URLSearchParams): ApiQuery {
  const query: ApiQuery = {}
  for (const [key, value] of params.entries()) {
    const current = query[key]
    if (current === undefined) {
      query[key] = value
    } else if (Array.isArray(current)) {
      current.push(value)
    } else {
      query[key] = [current, value]
    }
  }
  return validateQuery(query)
}

function parseNextLink(
  response: Response,
  config: WrapperConfig,
): PaginationMetadata | null {
  const link = response.headers.get("link")
  if (!link) return null
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i)
    if (!match?.[1]) continue
    const resultsMatch = part.match(/;\s*results="?([^"\s;]+)"?/i)
    if (resultsMatch?.[1] === "false") return { hasNext: false }
    let next: URL
    try {
      next = new URL(match[1], config.sentryOrigin)
    } catch {
      return { hasNext: false }
    }
    if (next.origin !== config.sentryOrigin) return { hasNext: false }
    let nextPath: string
    try {
      nextPath = validateApiPath(next.pathname, config.sentryOrigin)
      const query = queryFromParams(next.searchParams)
      assertConfiguredScope(
        nextPath,
        query,
        config.organizationSlug,
        config.projectSlug,
      )
    } catch {
      return { hasNext: false }
    }
    return {
      hasNext: true,
      nextCursor: next.searchParams.get("cursor") ?? undefined,
      nextPath: `${nextPath}${next.search}`,
    }
  }
  return { hasNext: false }
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const contentLength = response.headers.get("content-length")
  if (contentLength && Number(contentLength) > maxBytes) {
    await response.body?.cancel()
    throw new SentryApiError(
      `Sentry response exceeded the ${maxBytes} byte limit`,
      "response-too-large",
    )
  }
  if (!response.body) return { bytes: new Uint8Array(), truncated: false }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const remaining = maxBytes - size
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining))
        size = maxBytes
        truncated = true
        await reader.cancel()
        break
      }
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

function parseBody(
  bytes: Uint8Array,
  contentType: string | null,
  truncated: boolean,
): unknown {
  if (bytes.byteLength === 0) return null
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase()
  const isJson =
    mediaType === "application/json" || mediaType?.endsWith("+json")
  const isText = mediaType?.startsWith("text/")
  if (!isJson && !isText) {
    throw new SentryApiError(
      `Sentry returned unsupported content type ${mediaType ?? "(missing)"}`,
      "unsupported-content",
    )
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  if (truncated) return text
  if (isJson) {
    try {
      return JSON.parse(text)
    } catch {
      throw new SentryApiError(
        "Sentry returned invalid JSON content",
        "unsupported-content",
      )
    }
  }
  return text
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}

export class SentryApiClient {
  readonly origin: string
  readonly permissions: TokenPermissions

  constructor(
    private readonly config: WrapperConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.origin = config.sentryOrigin
    this.permissions = new TokenPermissions(() =>
      this.requestInternal("/api/0/", undefined, {
        timeoutMs: Math.min(config.apiTimeoutMs, 5_000),
        maxResponseBytes: config.apiMaxResponseBytes,
      }),
    )
  }

  async get(path: string, query?: ApiQuery): Promise<ApiResponse> {
    return this.request(path, query, {
      method: "GET",
      authenticate: true,
      requireApiPath: true,
      enforceScope: true,
    })
  }

  async updateIssue(
    issueId: string,
    update: IssueUpdate,
  ): Promise<ApiResponse> {
    issueIdSchema.parse(issueId)
    const body = JSON.stringify(issueUpdateSchema.parse(update))
    await this.permissions.require([scopeAlternatives("event:write")])
    await this.assertIssueWithinScope(issueId)
    const path = `/api/0/organizations/${encodeURIComponent(this.config.organizationSlug)}/issues/${encodeURIComponent(issueId)}/`
    return withIssueUpdate(this.origin, path, body, () =>
      this.request(path, undefined, {
        method: "PUT",
        body,
        authenticate: true,
        requireApiPath: true,
        enforceScope: true,
      }),
    )
  }

  async managementRequest(
    method: "PUT" | "POST" | "DELETE",
    path: string,
    body: Record<string, unknown> | undefined,
    requirements: string[][],
  ): Promise<ApiResponse> {
    await this.permissions.require(requirements)
    return this.request(path, undefined, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      authenticate: true,
      requireApiPath: true,
      enforceScope: true,
    })
  }

  async requestInternal(
    path: string,
    query?: ApiQuery,
    options: Omit<RequestOptions, "method" | "body"> & {
      method?: "GET" | "HEAD" | "OPTIONS"
    } = {},
  ): Promise<ApiResponse> {
    return this.request(path, query, {
      method: options.method ?? "GET",
      authenticate: options.authenticate ?? true,
      requireApiPath: options.requireApiPath ?? path.startsWith("/api/0/"),
      enforceScope: options.enforceScope ?? false,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
    })
  }

  async assertIssueWithinScope(issueId: string): Promise<void> {
    const issuePath = `/api/0/organizations/${encodeURIComponent(
      this.config.organizationSlug,
    )}/issues/${encodeURIComponent(issueId)}/`
    const issue = await this.requestInternal(issuePath, undefined, {
      maxResponseBytes: Math.min(this.config.apiMaxResponseBytes, 262_144),
    })
    if (issue.status < 200 || issue.status >= 300) {
      throw new SentryApiError(
        "The issue scope could not be verified with the configured credentials",
        "scope",
      )
    }
    if (
      !issue.contentType?.toLowerCase().startsWith("application/json") ||
      !issue.body ||
      typeof issue.body !== "object" ||
      Array.isArray(issue.body)
    ) {
      throw new SentryApiError(
        "The issue scope response was not a valid Sentry JSON object",
        "scope",
      )
    }
    const body =
      issue.body && typeof issue.body === "object"
        ? (issue.body as Record<string, unknown>)
        : {}
    const project =
      body.project && typeof body.project === "object"
        ? (body.project as Record<string, unknown>)
        : {}
    const issueProjectSlug =
      typeof project.slug === "string" ? project.slug : undefined

    if (
      this.config.projectSlug &&
      issueProjectSlug !== this.config.projectSlug
    ) {
      throw new SentryApiError(
        "The issue is outside the configured Sentry project scope",
        "scope",
      )
    }
    if (this.config.projectSlug && !issueProjectSlug) {
      throw new SentryApiError(
        "The issue response did not contain enough project information to verify scope",
        "scope",
      )
    }
  }

  private async request(
    rawPath: string,
    rawQuery: ApiQuery | undefined,
    options: RequestOptions,
  ): Promise<ApiResponse> {
    const method = options.method ?? "GET"
    const path = options.requireApiPath
      ? validateApiPath(rawPath, this.origin)
      : this.validateInternalPath(rawPath)
    const query = validateQuery(rawQuery)
    this.assertQueryLimits(query)

    if (options.enforceScope) {
      const scope = assertConfiguredScope(
        path,
        query,
        this.config.organizationSlug,
        this.config.projectSlug,
      )
      if (scope.issueId) await this.assertIssueWithinScope(scope.issueId)
    }

    const requestUrl = new URL(path, this.origin)
    appendQuery(requestUrl, query)
    const timeoutMs = options.timeoutMs ?? this.config.apiTimeoutMs
    const maxResponseBytes =
      options.maxResponseBytes ?? this.config.apiMaxResponseBytes

    try {
      return await this.performRequest(
        requestUrl,
        path,
        method,
        options.authenticate ?? true,
        options.enforceScope ?? false,
        timeoutMs,
        maxResponseBytes,
        options.body,
      )
    } catch (error) {
      if (error instanceof SentryApiError) throw error
      const isAbort =
        error instanceof DOMException
          ? error.name === "AbortError" || error.name === "TimeoutError"
          : error instanceof Error &&
            (error.name === "AbortError" || error.name === "TimeoutError")
      throw new SentryApiError(
        isAbort
          ? `${method} ${path} timed out after ${timeoutMs}ms`
          : `${method} ${path} failed: ${redactErrorMessage(
              error,
              this.config.accessToken,
            )}`,
        isAbort ? "timeout" : "network",
      )
    }
  }

  private validateInternalPath(path: string): string {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      path.includes("\0")
    ) {
      throw new Error("internal path must remain on the configured origin")
    }
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin) {
      throw new Error("internal path must remain on the configured origin")
    }
    return url.pathname
  }

  private assertQueryLimits(query: ApiQuery): void {
    const perPage = query.per_page
    if (perPage === undefined) return
    const values = Array.isArray(perPage) ? perPage : [perPage]
    if (
      values.length !== 1 ||
      !/^\d+$/.test(values[0]!) ||
      Number(values[0]) < 1 ||
      Number(values[0]) > this.config.apiMaxItems
    ) {
      throw new Error(
        `query parameter per_page must be one integer no greater than ${this.config.apiMaxItems}`,
      )
    }
  }

  private async performRequest(
    initialUrl: URL,
    initialPath: string,
    method: "GET" | "HEAD" | "OPTIONS" | "PUT" | "POST" | "DELETE",
    authenticate: boolean,
    enforceScope: boolean,
    timeoutMs: number,
    maxResponseBytes: number,
    requestBody?: string,
  ): Promise<ApiResponse> {
    let url = initialUrl
    let redirects = 0
    const timeoutSignal = AbortSignal.timeout(timeoutMs)

    while (true) {
      const headers = new Headers({
        Accept: "application/json, text/plain;q=0.9, text/html;q=0.5",
        "User-Agent": `streaming-tech-sentry-mcp/${this.config.upstreamMcpRef.slice(
          0,
          12,
        )}`,
      })
      if (authenticate) {
        headers.set("Authorization", `Bearer ${this.config.accessToken}`)
      }
      if (requestBody !== undefined)
        headers.set("Content-Type", "application/json")
      const response = await this.fetchImpl(url, {
        method,
        body: requestBody,
        headers,
        redirect: "manual",
        signal: timeoutSignal,
      })

      if (isRedirect(response.status)) {
        if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
          await response.body?.cancel()
          throw new SentryApiError(
            "Write redirect rejected; inspect the resource before retrying",
            "redirect",
          )
        }
        const location = response.headers.get("location")
        if (!location || redirects >= MAX_REDIRECTS) {
          throw new SentryApiError(
            "Sentry redirect could not be followed within the configured limit",
            "redirect",
          )
        }
        const next = new URL(location, url)
        if (
          next.origin !== this.origin ||
          next.username !== "" ||
          next.password !== ""
        ) {
          throw new SentryApiError(
            "Sentry redirect attempted to leave the configured origin or add URL credentials",
            "redirect",
          )
        }
        if (initialPath.startsWith("/api/0/")) {
          const nextPath = validateApiPath(next.pathname, this.origin)
          const nextQuery = queryFromParams(next.searchParams)
          this.assertQueryLimits(nextQuery)
          if (enforceScope) {
            const scope = assertConfiguredScope(
              nextPath,
              nextQuery,
              this.config.organizationSlug,
              this.config.projectSlug,
            )
            if (scope.issueId) {
              await this.assertIssueWithinScope(scope.issueId)
            }
          }
        }
        url = next
        redirects += 1
        continue
      }

      const contentType = response.headers.get("content-type")
      const { bytes, truncated } = await readResponseBody(
        response,
        maxResponseBytes,
      )
      const body = redactValue(
        parseBody(bytes, contentType, truncated),
        this.config.accessToken,
      )
      return {
        status: response.status,
        contentType: contentType ?? undefined,
        request: { method, path: initialPath },
        pagination: parseNextLink(response, this.config),
        truncated,
        headers: headerSubset(response, this.config.accessToken),
        body,
      }
    }
  }
}
