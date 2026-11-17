import { describe, expect, it } from "vitest"
import { SentryApiClient } from "../src/sentry-api-client.ts"
import { ServerInfoStore } from "../src/server-info.ts"
import {
  credentialResponse,
  jsonResponse,
  mockFetch,
  testConfig,
} from "./helpers.ts"

describe("ServerInfoStore", () => {
  it("reports failed permission rediscovery even while capability results are cached", async () => {
    let valid = true
    const config = testConfig()
    const client = new SentryApiClient(
      config,
      mockFetch((url) => {
        if (url.pathname === "/api/0/")
          return valid
            ? credentialResponse()
            : jsonResponse({}, { status: 401 })
        if (url.pathname === "/")
          return new Response("<html></html>", {
            headers: { "content-type": "text/html" },
          })
        return jsonResponse([])
      }),
    )
    const store = new ServerInfoStore(config, client)
    await store.refresh()
    expect(store.current().tokenPermissions.status).toBe("ready")
    valid = false
    await client.permissions.refresh()
    expect(store.current()).toMatchObject({
      checkStatus: "degraded",
      enabledSkills: [],
      tokenPermissions: { status: "unavailable", scopes: [] },
    })
  })
  it.each([
    [200, "complete"],
    [403, "degraded"],
  ])(
    "ignores disabled Seer but retains enabled probe failures (%i)",
    async (status, checkStatus) => {
      const config = testConfig()
      const client = new SentryApiClient(
        config,
        mockFetch((url) => {
          if (url.pathname === "/api/0/") return credentialResponse()
          if (url.pathname === "/")
            return new Response('{"sentryVersion":"26.8.0"}', {
              headers: { "content-type": "text/html" },
            })
          if (url.pathname.endsWith("/issues/"))
            return jsonResponse([{ id: "123" }])
          if (url.pathname.endsWith("/events/latest/"))
            return jsonResponse({}, { status })
          return jsonResponse({})
        }),
      )
      const info = await new ServerInfoStore(config, client).refresh()
      expect(info.capabilities.seer.state).toBe("disabled")
      expect(info.checkStatus).toBe(checkStatus)
    },
  )

  it("uses the automatically detected version for the newer-server advisory", async () => {
    const config = testConfig()
    let bootstrapAuthorization: string | null = null
    const client = new SentryApiClient(
      config,
      mockFetch((url, init) => {
        if (url.pathname === "/") {
          bootstrapAuthorization = new Headers(init?.headers).get(
            "authorization",
          )
          return new Response(
            '<script>window.__initialData={"sentryVersion":"26.6.0"}</script>',
            { headers: { "content-type": "text/html" } },
          )
        }
        if (url.pathname.endsWith("/issues/")) return jsonResponse([])
        return jsonResponse({})
      }),
    )
    const info = await new ServerInfoStore(config, client).refresh()
    expect(bootstrapAuthorization).toBe("Bearer fake-token-value")
    expect(info.detectedVersion).toBe("26.6.0")
    expect(info.versionSource).toBe("bootstrap")
    expect(info.compatibilityReview).toMatchObject({
      required: true,
      testedThrough: "26.10.1",
      detectedVersion: "26.6.0",
    })
    expect(JSON.stringify(info)).not.toContain("fake-token-value")
  })

  it("starts without blocking when capability state is not yet known", () => {
    const config = testConfig()
    const store = new ServerInfoStore(
      config,
      new SentryApiClient(
        config,
        mockFetch(() => jsonResponse({})),
      ),
    )
    expect(store.current()).toMatchObject({
      checkStatus: "pending",
      compatibilityProfile: "unknown-conservative",
    })
  })

  it("deduplicates concurrent refreshes and retains a fresh cache", async () => {
    const config = testConfig()
    let requests = 0
    const store = new ServerInfoStore(
      config,
      new SentryApiClient(
        config,
        mockFetch((url) => {
          if (url.pathname === "/api/0/") return credentialResponse()
          requests += 1
          if (url.pathname === "/") {
            return new Response("<html></html>", {
              headers: { "content-type": "text/html" },
            })
          }
          if (url.pathname.endsWith("/issues/")) return jsonResponse([])
          return jsonResponse({})
        }),
      ),
    )

    await Promise.all([store.refresh(), store.refresh()])
    const afterRefresh = requests
    store.refreshIfStale()
    await Promise.resolve()
    expect(requests).toBe(afterRefresh)
  })

  it("keeps concurrently detected instances on independent profiles", async () => {
    const baselineConfig = testConfig()
    const newerConfig = testConfig({
      SENTRY_HOST: "newer-sentry.example.test",
    })
    const makeFetch = (version: string, eventsValidateStatus: number) =>
      mockFetch((url) => {
        if (url.pathname === "/api/0/") return credentialResponse()
        if (url.pathname === "/") {
          return new Response(`{"sentryVersion":"${version}"}`, {
            headers: { "content-type": "text/html" },
          })
        }
        if (url.pathname.endsWith("/events/validate/")) {
          return jsonResponse(
            eventsValidateStatus === 200 ? {} : { detail: "missing" },
            { status: eventsValidateStatus },
          )
        }
        if (url.pathname.endsWith("/issues/")) return jsonResponse([])
        return jsonResponse({})
      })

    const [baseline, newer] = await Promise.all([
      new ServerInfoStore(
        baselineConfig,
        new SentryApiClient(baselineConfig, makeFetch("26.5.1", 404)),
      ).refresh(),
      new ServerInfoStore(
        newerConfig,
        new SentryApiClient(newerConfig, makeFetch("26.11.0", 200)),
      ).refresh(),
    ])
    expect(baseline.compatibilityProfile).toBe("self-hosted-26.5")
    expect(newer.compatibilityProfile).toBe("self-hosted-current")
    expect(newer.compatibilityReview.required).toBe(true)
  })

  it("supports force refresh and automatically refreshes when pending or stale", async () => {
    const config = testConfig()
    let requests = 0
    const store = new ServerInfoStore(
      config,
      new SentryApiClient(
        config,
        mockFetch((url) => {
          if (url.pathname === "/api/0/") return credentialResponse()
          requests += 1
          if (url.pathname === "/") {
            return new Response('{"sentryVersion":"26.7.0"}', {
              headers: { "content-type": "text/html" },
            })
          }
          if (url.pathname.endsWith("/issues/")) return jsonResponse([])
          return jsonResponse({})
        }),
      ),
    )

    expect(store.isStale()).toBe(true)
    const initial = await store.getOrRefresh(false)
    expect(initial.detectedVersion).toBe("26.7.0")
    expect(store.isStale()).toBe(false)
    const requestCountAfterInit = requests

    // Not stale -> returns cached without extra network requests
    const cached = await store.getOrRefresh(false)
    expect(cached.detectedVersion).toBe("26.7.0")
    expect(requests).toBe(requestCountAfterInit)

    // Forced refresh -> makes network requests even when fresh
    const refreshed = await store.getOrRefresh(true)
    expect(refreshed.detectedVersion).toBe("26.7.0")
    expect(requests).toBeGreaterThan(requestCountAfterInit)
  })
})
