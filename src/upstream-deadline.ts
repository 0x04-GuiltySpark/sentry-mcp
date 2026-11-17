import { AsyncLocalStorage } from "node:async_hooks"

const issueUpdate = new AsyncLocalStorage<{
  origin: string
  path: string
  body: string
}>()

// Authorise only the exact request built by the scoped issue-update client.
export function withIssueUpdate<T>(
  origin: string,
  path: string,
  body: string,
  operation: () => Promise<T>,
): Promise<T> {
  return issueUpdate.run({ origin, path, body }, operation)
}

const INSTALLED_MARKER = Symbol.for(
  "streaming-tech.sentry.fetchDeadlineInstalled",
)

type MarkedGlobal = typeof globalThis & {
  [INSTALLED_MARKER]?: boolean
}

type FetchInput = string | URL | Request

const managementOperation = new AsyncLocalStorage<{
  origin: string
  deadline: number
  authorise: (url: URL, method: string) => Promise<void>
  sent: Set<string>
}>()

export function withManagementOperation<T>(
  origin: string,
  authorise: (url: URL, method: string) => Promise<void>,
  operation: () => Promise<T>,
  timeoutMs = 60_000,
): Promise<T> {
  return managementOperation.run(
    { origin, deadline: Date.now() + timeoutMs, authorise, sent: new Set() },
    operation,
  )
}

function requestUrl(input: FetchInput): URL | undefined {
  try {
    if (input instanceof URL) return input
    if (typeof input === "string") return new URL(input)
    return new URL(input.url)
  } catch {
    return undefined
  }
}

export function installUpstreamSentryDeadline(
  sentryOrigin: string,
  timeoutMs: number,
  compatibility?: (url: URL, response: Response) => Promise<Response>,
): void {
  const markedGlobal = globalThis as MarkedGlobal
  if (markedGlobal[INSTALLED_MARKER]) return

  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (
    input: FetchInput,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input)
    const management = managementOperation.getStore()
    if (
      management &&
      url?.pathname.startsWith("/api/0/") &&
      url.origin !== management.origin
    )
      throw new Error(
        "Management requests must remain on the configured Sentry origin",
      )
    if (!url || url.origin !== sentryOrigin) {
      return originalFetch(input, init)
    }
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase()
    const permitted = issueUpdate.getStore()
    const isIssueUpdate =
      method === "PUT" &&
      permitted?.origin === url.origin &&
      permitted.path === url.pathname &&
      !url.search &&
      !url.hash &&
      init?.body === permitted.body
    const isManagementWrite =
      management && method !== "GET" && method !== "HEAD"
    if (isManagementWrite) {
      await management.authorise(url, method)
      if (Date.now() >= management.deadline)
        throw new Error("Management operation deadline expired before writing")
      const body =
        init?.body ??
        (input instanceof Request ? await input.clone().text() : "")
      if (typeof body !== "string")
        throw new Error("Management writes require a JSON/text body")
      const fingerprint = `${method} ${url.href} ${body}`
      if (management.sent.has(fingerprint))
        throw new Error(
          "Automatic write replay blocked; inspect the resource before retrying",
        )
      management.sent.add(fingerprint)
    }
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      !isIssueUpdate &&
      !isManagementWrite
    ) {
      throw new Error("The Sentry request guard blocks unauthorised writes")
    }
    let inputSignal = init?.signal
    if (!inputSignal && typeof input === "object" && "signal" in input) {
      inputSignal = input.signal
    }
    const remainingMs = management
      ? Math.min(timeoutMs, management.deadline - Date.now())
      : timeoutMs
    if (remainingMs <= 0)
      throw new Error("Management operation deadline expired")
    const timeoutSignal = AbortSignal.timeout(remainingMs)
    const signal = inputSignal
      ? AbortSignal.any([inputSignal, timeoutSignal])
      : timeoutSignal
    const response = await originalFetch(input, {
      ...init,
      signal,
      ...(isManagementWrite ? { redirect: "manual" as const } : {}),
    })
    if (isManagementWrite && response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new Error(
        "Management write redirect rejected; inspect the resource before retrying",
      )
    }
    return method === "GET" && compatibility
      ? compatibility(url, response)
      : response
  }
  markedGlobal[INSTALLED_MARKER] = true
}
