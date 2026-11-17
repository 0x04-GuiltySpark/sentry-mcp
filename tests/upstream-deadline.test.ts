import { afterEach, describe, expect, it, vi } from "vitest"
import {
  installUpstreamSentryDeadline,
  withIssueUpdate,
  withManagementOperation,
} from "../src/upstream-deadline.ts"

describe("upstream Sentry deadline", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(
      globalThis,
      Symbol.for("streaming-tech.sentry.fetchDeadlineInstalled"),
    )
  })

  it("blocks automatic write replay and does not follow redirects", async () => {
    const original = vi.fn(async () => new Response("{}", { status: 500 }))
    vi.stubGlobal("fetch", original)
    const origin = "https://sentry.example.test"
    installUpstreamSentryDeadline(origin, 1000)
    await withManagementOperation(
      origin,
      async () => {},
      async () => {
        await fetch(`${origin}/api/0/organizations/example/teams/`, {
          method: "POST",
          body: "{}",
        })
        await expect(
          fetch(`${origin}/api/0/organizations/example/teams/`, {
            method: "POST",
            body: "{}",
          }),
        ).rejects.toThrow("replay")
      },
    )
    expect(original).toHaveBeenCalledTimes(1)
    original.mockImplementation(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://outside.test/api/0/" },
        }),
    )
    await expect(
      withManagementOperation(
        origin,
        async () => {},
        () =>
          fetch(`${origin}/api/0/organizations/example/teams/`, {
            method: "POST",
            body: "{}",
          }),
      ),
    ).rejects.toThrow("redirect")
    expect(original).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "manual" }),
    )
    expect(original).toHaveBeenCalledTimes(2)
  })

  it("refuses cross-origin and expired management writes before dispatch", async () => {
    const original = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", original)
    const origin = "https://sentry.example.test"
    installUpstreamSentryDeadline(origin, 1000)
    await expect(
      withManagementOperation(
        origin,
        async () => {},
        () =>
          fetch("https://outside.test/api/0/organizations/example/teams/", {
            method: "POST",
          }),
      ),
    ).rejects.toThrow("origin")
    await expect(
      withManagementOperation(
        origin,
        async () => {},
        () =>
          fetch(`${origin}/api/0/organizations/example/teams/`, {
            method: "POST",
          }),
        0,
      ),
    ).rejects.toThrow("deadline")
    expect(original).not.toHaveBeenCalled()
  })

  it("blocks a nested Seer or mutation request before it reaches Sentry", async () => {
    const original = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", original)
    installUpstreamSentryDeadline("https://sentry.example.test", 1000)
    await expect(
      fetch(
        "https://sentry.example.test/api/0/organizations/example/search-agent/",
        { method: "POST" },
      ),
    ).rejects.toThrow("unauthorised writes")
    await expect(
      fetch(
        new Request("https://sentry.example.test/api/0/issues/123/", {
          method: "PUT",
        }),
      ),
    ).rejects.toThrow("unauthorised writes")
    expect(original).not.toHaveBeenCalled()
  })

  it("aborts an upstream Sentry request when the wrapper timeout expires", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            )
          }),
      ),
    )
    installUpstreamSentryDeadline("https://sentry.example.test", 25)

    await expect(
      fetch("https://sentry.example.test/api/0/"),
    ).rejects.toMatchObject({ name: "TimeoutError" })
  })

  it("permits only an authorised issue PUT and isolates concurrent inspection requests", async () => {
    const original = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", original)
    const origin = "https://sentry.example.test"
    const path = "/api/0/organizations/example/issues/123/"
    const body = JSON.stringify({ priority: "high" })
    installUpstreamSentryDeadline(origin, 1000)
    await Promise.all([
      withIssueUpdate(origin, path, body, async () => {
        await fetch(origin + path, { method: "PUT", body })
        await expect(
          fetch(origin + path, { method: "DELETE", body }),
        ).rejects.toThrow("unauthorised writes")
        await expect(
          fetch(origin + path, { method: "PUT", body: "{}" }),
        ).rejects.toThrow("unauthorised writes")
        await expect(
          fetch(`${origin}${path}?id=other`, { method: "PUT", body }),
        ).rejects.toThrow("unauthorised writes")
        await expect(
          fetch(origin + path.replace("123", "456"), { method: "PUT", body }),
        ).rejects.toThrow("unauthorised writes")
      }),
      expect(fetch(origin + path, { method: "PUT", body })).rejects.toThrow(
        "unauthorised writes",
      ),
    ])
    expect(original).toHaveBeenCalledTimes(1)
    await expect(fetch(origin + path, { method: "PUT", body })).rejects.toThrow(
      "unauthorised writes",
    )
  })
})
