import { describe, expect, it, vi } from "vitest"
import { SentryApiClient } from "../src/sentry-api-client.ts"
import { jsonResponse, mockFetch, testConfig } from "./helpers.ts"

describe("SentryApiClient", () => {
  it("adds the token to the request and removes secrets from the response", async () => {
    const fetchImpl = vi.fn(
      mockFetch((_url, init) => {
        const headers = new Headers(init?.headers)
        expect(headers.get("authorization")).toBe("Bearer fake-token-value")
        return jsonResponse(
          {
            ok: true,
            access_token: "response-secret",
            echoed: "fake-token-value",
          },
          {
            headers: {
              "x-sentry-error": "Bearer fake-token-value",
            },
          },
        )
      }),
    ) as typeof fetch
    const client = new SentryApiClient(testConfig(), fetchImpl)

    const response = await client.get(
      "/api/0/organizations/example-org/issues/",
      { per_page: "1" },
    )
    expect(response.body).toEqual({
      ok: true,
      access_token: "[REDACTED]",
      echoed: "[REDACTED]",
    })
    expect(JSON.stringify(response)).not.toContain("fake-token-value")
    expect(response.headers["x-sentry-error"]).toBe("Bearer [REDACTED]")
  })

  it("rejects invalid paths before a network request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const client = new SentryApiClient(testConfig(), fetchImpl)
    await expect(
      client.get("https://other.example/api/0/issues/"),
    ).rejects.toThrow()
    await expect(
      client.get("/api/0/organizations/other-org/issues/"),
    ).rejects.toThrow(/organization scope/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("enforces the configured per-page item ceiling", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const client = new SentryApiClient(testConfig(), fetchImpl)
    await expect(
      client.get("/api/0/organizations/example-org/issues/", {
        per_page: "251",
      }),
    ).rejects.toThrow(/no greater than 250/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("checks issue and project scope before an organisation-less issue read", async () => {
    const seen: string[] = []
    const client = new SentryApiClient(
      testConfig({ SENTRY_PROJECT_SLUG: "example-project" }),
      mockFetch((url) => {
        seen.push(url.pathname)
        if (url.pathname === "/api/0/organizations/example-org/issues/123/") {
          return jsonResponse({ project: { slug: "example-project" } })
        }
        if (url.pathname === "/api/0/issues/123/events/latest/") {
          return jsonResponse({ eventID: "fake-event" })
        }
        return jsonResponse({ detail: "missing" }, { status: 404 })
      }),
    )
    const response = await client.get("/api/0/issues/123/events/latest/")
    expect(response.status).toBe(200)
    expect(seen).toEqual([
      "/api/0/organizations/example-org/issues/123/",
      "/api/0/issues/123/events/latest/",
    ])
  })

  it("rejects an issue that does not belong to the configured organisation", async () => {
    const client = new SentryApiClient(
      testConfig(),
      mockFetch((url) => {
        if (url.pathname === "/api/0/organizations/example-org/issues/123/") {
          return jsonResponse({ detail: "not found" }, { status: 404 })
        }
        return jsonResponse({ detail: "not found" }, { status: 404 })
      }),
    )
    await expect(
      client.get("/api/0/issues/123/events/latest/"),
    ).rejects.toMatchObject({ code: "scope" })
  })

  it("rejects cross-origin redirects and binary content", async () => {
    const redirectClient = new SentryApiClient(
      testConfig(),
      mockFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://other.example/api/0/issues/" },
          }),
      ),
    )
    await expect(
      redirectClient.get("/api/0/organizations/example-org/issues/"),
    ).rejects.toMatchObject({ code: "redirect" })

    const binaryClient = new SentryApiClient(
      testConfig(),
      mockFetch(
        () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "application/octet-stream" },
          }),
      ),
    )
    await expect(
      binaryClient.get("/api/0/organizations/example-org/issues/"),
    ).rejects.toMatchObject({ code: "unsupported-content" })
  })

  it("reapplies credential and item-limit checks to redirects", async () => {
    const credentialRedirect = new SentryApiClient(
      testConfig(),
      mockFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: {
              location:
                "https://user:password@sentry.example.test/api/0/organizations/example-org/issues/",
            },
          }),
      ),
    )
    await expect(
      credentialRedirect.get("/api/0/organizations/example-org/issues/"),
    ).rejects.toMatchObject({ code: "redirect" })

    const oversizedPageRedirect = new SentryApiClient(
      testConfig(),
      mockFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: {
              location: "/api/0/organizations/example-org/issues/?per_page=251",
            },
          }),
      ),
    )
    await expect(
      oversizedPageRedirect.get("/api/0/organizations/example-org/issues/"),
    ).rejects.toThrow(/no greater than 250/)
  })

  it("parses JSON and text and rejects invalid JSON", async () => {
    const textClient = new SentryApiClient(
      testConfig(),
      mockFetch(
        () =>
          new Response("fixture text", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
      ),
    )
    expect(
      (await textClient.get("/api/0/organizations/example-org/issues/")).body,
    ).toBe("fixture text")

    const invalidJsonClient = new SentryApiClient(
      testConfig(),
      mockFetch(
        () =>
          new Response("{not-json", {
            headers: { "content-type": "application/json" },
          }),
      ),
    )
    await expect(
      invalidJsonClient.get("/api/0/organizations/example-org/issues/"),
    ).rejects.toMatchObject({ code: "unsupported-content" })
  })

  it("enforces response size and timeout limits", async () => {
    const oversized = new SentryApiClient(
      testConfig({ SENTRY_API_MAX_RESPONSE_BYTES: "1024" }),
      mockFetch(
        () =>
          new Response("small", {
            headers: {
              "content-type": "text/plain",
              "content-length": "2048",
            },
          }),
      ),
    )
    await expect(
      oversized.get("/api/0/organizations/example-org/issues/"),
    ).rejects.toMatchObject({ code: "response-too-large" })

    const timedOut = new SentryApiClient(
      testConfig({ SENTRY_API_TIMEOUT_MS: "1000" }),
      mockFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            )
          }),
      ),
    )
    await expect(
      timedOut.get("/api/0/organizations/example-org/issues/"),
    ).rejects.toMatchObject({ code: "timeout" })
  })

  it("accepts pagination links only from the configured Sentry origin", async () => {
    const client = new SentryApiClient(
      testConfig(),
      mockFetch(() =>
        jsonResponse([{ id: "1" }], {
          headers: {
            link: '<https://sentry.example.test/api/0/organizations/example-org/issues/?cursor=next>; rel="next"',
          },
        }),
      ),
    )
    const response = await client.get(
      "/api/0/organizations/example-org/issues/",
    )
    expect(response.pagination).toEqual({
      hasNext: true,
      nextCursor: "next",
      nextPath: "/api/0/organizations/example-org/issues/?cursor=next",
    })
  })

  it("rejects redirected and pagination paths that leave configured scope", async () => {
    const redirected = new SentryApiClient(
      testConfig(),
      mockFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: {
              location: "/api/0/organizations/other-org/issues/",
            },
          }),
      ),
    )
    await expect(
      redirected.get("/api/0/organizations/example-org/issues/"),
    ).rejects.toThrow(/organization scope/)

    const paginated = new SentryApiClient(
      testConfig(),
      mockFetch(() =>
        jsonResponse([], {
          headers: {
            link: '<https://sentry.example.test/api/0/organizations/other-org/issues/?cursor=next>; rel="next"',
          },
        }),
      ),
    )
    const response = await paginated.get(
      "/api/0/organizations/example-org/issues/",
    )
    expect(response.pagination).toEqual({ hasNext: false })

    const credentialLink = new SentryApiClient(
      testConfig(),
      mockFetch(() =>
        jsonResponse([], {
          headers: {
            link: '<https://sentry.example.test/api/0/organizations/example-org/issues/?access_token=leak>; rel="next"',
          },
        }),
      ),
    )
    expect(
      (await credentialLink.get("/api/0/organizations/example-org/issues/"))
        .pagination,
    ).toEqual({ hasNext: false })

    const resultsFalseLink = new SentryApiClient(
      testConfig(),
      mockFetch(() =>
        jsonResponse([], {
          headers: {
            link: '<https://sentry.example.test/api/0/organizations/example-org/issues/?cursor=next>; rel="next"; results="false"',
          },
        }),
      ),
    )
    expect(
      (await resultsFalseLink.get("/api/0/organizations/example-org/issues/"))
        .pagination,
    ).toEqual({ hasNext: false })

    const resultsFalseUnquotedLink = new SentryApiClient(
      testConfig(),
      mockFetch(() =>
        jsonResponse([], {
          headers: {
            link: '<https://sentry.example.test/api/0/organizations/example-org/issues/?cursor=next>; rel="next"; results=false',
          },
        }),
      ),
    )
    expect(
      (
        await resultsFalseUnquotedLink.get(
          "/api/0/organizations/example-org/issues/",
        )
      ).pagination,
    ).toEqual({ hasNext: false })

    const resultsTrueLink = new SentryApiClient(
      testConfig(),
      mockFetch(() =>
        jsonResponse([], {
          headers: {
            link: '<https://sentry.example.test/api/0/organizations/example-org/issues/?cursor=next>; rel="next"; results="true"',
          },
        }),
      ),
    )
    expect(
      (await resultsTrueLink.get("/api/0/organizations/example-org/issues/"))
        .pagination,
    ).toEqual({
      hasNext: true,
      nextCursor: "next",
      nextPath: "/api/0/organizations/example-org/issues/?cursor=next",
    })
  })
})
