import { describe, expect, it, vi } from "vitest"
import { probeCapabilities } from "../src/compatibility/probe-capabilities.ts"
import { SentryApiClient } from "../src/sentry-api-client.ts"
import { jsonResponse, mockFetch, testConfig } from "./helpers.ts"

function baselineFetch(statusOverride?: number): typeof fetch {
  return mockFetch((url) => {
    if (statusOverride) {
      return jsonResponse({ detail: "auth" }, { status: statusOverride })
    }
    if (url.pathname.endsWith("/events/validate/")) {
      return jsonResponse({ detail: "missing" }, { status: 404 })
    }
    if (url.pathname.endsWith("/replays/")) {
      return jsonResponse({ detail: "missing" }, { status: 404 })
    }
    if (url.pathname.endsWith("/issues/")) {
      return jsonResponse([{ id: "123" }])
    }
    if (url.pathname.endsWith("/autofix/")) {
      return jsonResponse({ detail: "missing" }, { status: 404 })
    }
    return jsonResponse([])
  })
}

describe("capability probes", () => {
  it.each([
    [undefined, true],
    ["131072", null],
  ])(
    "checks issue event size against the configured response limit %s",
    async (limit, supported) => {
      const config = testConfig({ SENTRY_API_MAX_RESPONSE_BYTES: limit })
      const body = JSON.stringify({ context: "x".repeat(256 * 1024) })
      const capabilities = await probeCapabilities(
        config,
        new SentryApiClient(
          config,
          mockFetch((url) => {
            if (url.pathname.endsWith("/issues/"))
              return jsonResponse([{ id: "123" }])
            if (url.pathname.endsWith("/events/latest/"))
              return new Response(body, {
                headers: {
                  "content-type": "application/json",
                  "content-length": String(Buffer.byteLength(body)),
                },
              })
            return jsonResponse({})
          }),
        ),
      )
      expect(capabilities.issueEvents.supported).toBe(supported)
      if (supported === null)
        expect(capabilities.issueEvents.reason).toContain("131072 byte limit")
    },
  )

  it("allows an event probe to take longer than five seconds", async () => {
    vi.useFakeTimers()
    try {
      const config = testConfig()
      const pending = probeCapabilities(
        config,
        new SentryApiClient(
          config,
          mockFetch((url, init) => {
            if (url.pathname.endsWith("/issues/"))
              return jsonResponse([{ id: "123" }])
            if (url.pathname.endsWith("/events/latest/"))
              return new Promise<Response>((resolve, reject) => {
                setTimeout(() => resolve(jsonResponse({})), 6000)
                init?.signal?.addEventListener("abort", () =>
                  reject(init.signal?.reason),
                )
              })
            return jsonResponse({})
          }),
        ),
      )
      await vi.runAllTimersAsync()
      expect((await pending).issueEvents.supported).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(["available", "empty", "denied", "failed"])(
    "never probes Seer when issue discovery is %s",
    async (discovery) => {
      const config = testConfig()
      const paths: string[] = []
      const capabilities = await probeCapabilities(
        config,
        new SentryApiClient(
          config,
          mockFetch((url) => {
            paths.push(url.pathname)
            if (url.pathname.endsWith("/issues/")) {
              if (discovery === "failed") throw new Error("connection failed")
              if (discovery === "denied")
                return jsonResponse({}, { status: 403 })
              return jsonResponse(discovery === "empty" ? [] : [{ id: "123" }])
            }
            return jsonResponse({})
          }),
        ),
      )
      expect(paths.some((path) => path.endsWith("/autofix/"))).toBe(false)
      expect(capabilities.seer).toMatchObject({
        supported: null,
        state: "disabled",
        source: "configured",
      })
    },
  )

  it("does not infer working datasets from a successful validation endpoint", async () => {
    const config = testConfig()
    const client = new SentryApiClient(
      config,
      mockFetch((url) => {
        if (url.pathname.endsWith("/events/"))
          return jsonResponse(
            { detail: "query unavailable" },
            { status: url.searchParams.get("dataset") === "logs" ? 504 : 400 },
          )
        if (url.pathname.endsWith("/issues/")) return jsonResponse([])
        return jsonResponse({ valid: true })
      }),
    )
    const capabilities = await probeCapabilities(config, client)
    expect(capabilities.eventsValidate.supported).toBe(true)
    expect(capabilities.profileSearch.supported).not.toBe(true)
    expect(capabilities.logSearch).toMatchObject({
      supported: null,
      state: "unavailable",
      status: 504,
    })
  })

  it("models the Sentry 26.5.1 fixture without events/validate", async () => {
    const config = testConfig()
    const capabilities = await probeCapabilities(
      config,
      new SentryApiClient(config, baselineFetch()),
    )
    expect(capabilities.eventsValidate).toMatchObject({
      supported: false,
      state: "unsupported",
      status: 404,
    })
    expect(capabilities.organizationEvents.supported).toBe(true)
    expect(capabilities.issueEvents.supported).toBe(true)
    expect(capabilities.traceItemAttributes.supported).toBe(true)
  })

  it("recognises a newer fixture with events/validate", async () => {
    const config = testConfig()
    const client = new SentryApiClient(
      config,
      mockFetch((url) => {
        if (url.pathname.endsWith("/issues/")) return jsonResponse([])
        return jsonResponse({})
      }),
    )
    const capabilities = await probeCapabilities(config, client)
    expect(capabilities.eventsValidate.supported).toBe(true)
  })

  it.each([
    [400, "supported", true],
    [401, "inaccessible", null],
    [403, "inaccessible", null],
    [404, "unsupported", false],
    [500, "unavailable", null],
  ] as const)(
    "classifies capability status %i as %s",
    async (status, state, supported) => {
      const config = testConfig()
      const capabilities = await probeCapabilities(
        config,
        new SentryApiClient(config, baselineFetch(status)),
      )
      expect(capabilities.apiRoot).toMatchObject({
        state,
        supported,
        status,
      })
    },
  )

  it("classifies a capability timeout as unavailable", async () => {
    const config = testConfig({ SENTRY_API_TIMEOUT_MS: "1000" })
    const capabilities = await probeCapabilities(
      config,
      new SentryApiClient(
        config,
        mockFetch(
          (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(init.signal?.reason),
              )
            }),
        ),
      ),
    )
    expect(capabilities.apiRoot).toMatchObject({
      state: "unavailable",
      supported: null,
    })
  })

  it("distinguishes inaccessible and unavailable probes", async () => {
    const config = testConfig()
    const inaccessible = await probeCapabilities(
      config,
      new SentryApiClient(config, baselineFetch(403)),
    )
    expect(inaccessible.organizationAccess.state).toBe("inaccessible")

    const unavailable = await probeCapabilities(
      config,
      new SentryApiClient(
        config,
        mockFetch(() => {
          throw new Error("connection refused")
        }),
      ),
    )
    expect(unavailable.apiRoot.state).toBe("unavailable")
  })

  it("does not treat a proxy HTML page as endpoint support", async () => {
    const config = testConfig()
    const capabilities = await probeCapabilities(
      config,
      new SentryApiClient(
        config,
        mockFetch(
          () =>
            new Response("<html>gateway login</html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
        ),
      ),
    )
    expect(capabilities.apiRoot).toMatchObject({
      supported: null,
      state: "unknown",
    })
  })
})
