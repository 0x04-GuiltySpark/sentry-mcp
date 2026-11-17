import { describe, expect, it, vi } from "vitest"
import { SentryReleaseCache } from "../src/compatibility/github-releases.ts"
import { jsonResponse, mockFetch } from "./helpers.ts"

const sha = "a".repeat(40)
const otherSha = "b".repeat(40)
const tag = (name = "27.1.0", hash = sha) => ({ name, commit: { sha: hash } })

describe("GitHub Sentry release cache", () => {
  it("discovers an unlisted release without sending Sentry credentials or the observed SHA", async () => {
    const fetcher = vi.fn(
      mockFetch((url, init) => {
        expect(url.origin).toBe("https://api.github.com")
        expect(url.pathname).toBe("/repos/getsentry/sentry/tags")
        expect(url.href).not.toContain(sha)
        expect(new Headers(init?.headers).has("authorization")).toBe(false)
        expect(init).toMatchObject({ redirect: "error", credentials: "omit" })
        return jsonResponse([tag()])
      }),
    )
    const cache = new SentryReleaseCache(fetcher)
    expect(await cache.resolve(sha)).toBe("27.1.0")
    expect(await cache.resolve(sha.toUpperCase())).toBe("27.1.0")
    expect(await cache.resolve(otherSha)).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("refreshes the catalogue after one hour and recognises a newly published release", async () => {
    let now = 0
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([tag()]))
      .mockResolvedValueOnce(jsonResponse([tag(), tag("27.2.0", otherSha)]))
    const cache = new SentryReleaseCache(fetcher, () => now)
    expect(await cache.resolve(sha)).toBe("27.1.0")
    now = 60 * 60 * 1000 - 1
    expect(await cache.resolve(otherSha)).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
    now += 1
    expect(await cache.resolve(otherSha)).toBe("27.2.0")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("shares one in-flight lookup between callers", async () => {
    const fetcher = vi.fn(async () => jsonResponse([tag()]))
    const cache = new SentryReleaseCache(fetcher)
    expect(await Promise.all([cache.resolve(sha), cache.resolve(sha)])).toEqual(
      ["27.1.0", "27.1.0"],
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("follows tag pages and accepts a v-prefixed release", async () => {
    const fetcher = vi.fn(
      mockFetch((url) =>
        jsonResponse(
          url.searchParams.get("page") === "1"
            ? Array.from({ length: 100 }, () => tag("development"))
            : [tag("v27.1.0")],
        ),
      ),
    )
    expect(await new SentryReleaseCache(fetcher).resolve(sha)).toBe("27.1.0")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("limits pagination even when every page is full", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(Array.from({ length: 100 }, () => tag("development"))),
    )
    expect(await new SentryReleaseCache(fetcher).resolve(sha)).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it("keeps cached mappings on rate limiting and waits 15 minutes before retrying", async () => {
    let now = 0
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([tag()]))
      .mockResolvedValueOnce(
        jsonResponse({ message: "rate limited" }, { status: 403 }),
      )
      .mockResolvedValueOnce(jsonResponse([tag(), tag("27.2.0", otherSha)]))
    const cache = new SentryReleaseCache(fetcher, () => now)
    await cache.resolve(sha)
    now += 60 * 60 * 1000
    expect(await cache.resolve(sha)).toBe("27.1.0")
    expect(await cache.resolve(otherSha)).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
    now += 15 * 60 * 1000
    expect(await cache.resolve(otherSha)).toBe("27.2.0")
  })

  it.each([
    () => new Response("not JSON"),
    () => jsonResponse({ message: "unexpected shape" }),
    () => jsonResponse([{ name: "27.1.0" }]),
    () => new Response("x".repeat(262_145)),
    () => {
      throw new Error("offline")
    },
    () => {
      throw new DOMException("timed out", "TimeoutError")
    },
  ])(
    "treats unavailable or malformed metadata as an unknown version",
    async (response) => {
      const fetcher = vi.fn(async () => response())
      const cache = new SentryReleaseCache(fetcher)
      expect(await cache.resolve(sha)).toBeUndefined()
      expect(await cache.resolve(sha)).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it("does not request metadata for malformed hashes or accept non-release tags", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse([tag("development"), tag("27.2.0-rc.1")]),
    )
    const cache = new SentryReleaseCache(fetcher)
    expect(await cache.resolve("not-a-hash")).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
    expect(await cache.resolve(sha)).toBeUndefined()
  })
})
