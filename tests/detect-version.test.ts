import { describe, expect, it, vi } from "vitest"
import {
  detectVersion,
  parseBootstrapRelease,
} from "../src/compatibility/detect-version.ts"
import { SentryApiClient } from "../src/sentry-api-client.ts"
import { jsonResponse, mockFetch, testConfig } from "./helpers.ts"

describe("bootstrap release parsing", () => {
  it("extracts a release SHA without assuming a version", () => {
    expect(
      parseBootstrapRelease(
        '<script>window.__initialData={"release":"91739d162d53d60fbf20711f0c72c6f170c61f93"}</script>',
      ),
    ).toEqual({
      version: undefined,
      releaseSha: "91739d162d53d60fbf20711f0c72c6f170c61f93",
    })
  })

  it("accepts explicit bootstrap semver and tolerates malformed content", () => {
    expect(parseBootstrapRelease('{"sentryVersion":"26.6.0"}').version).toBe(
      "26.6.0",
    )
    expect(parseBootstrapRelease("<html>not sentry</html>")).toEqual({})
    expect(parseBootstrapRelease({ release: "not text" })).toEqual({})
  })
})

describe("detectVersion", () => {
  it.each([
    ["26.7.2", "a8da553fe6f01f51cb05d253c641d2a074e38484"],
    ["26.8.0", "9f26ea80281e2b0b250a2d9678a2c5cbd22b705c"],
    ["26.10.1", "75be212fba6d4a1c43fc98030fc5e56edcdf176a"],
  ])(
    "ignores API version 0 and resolves the %s release SHA",
    async (version, release) => {
      const config = testConfig()
      const client = new SentryApiClient(
        config,
        mockFetch((url) =>
          url.pathname === "/api/0/"
            ? jsonResponse({ version: "0" })
            : new Response(JSON.stringify({ release }), {
                headers: { "content-type": "text/html" },
              }),
        ),
      )
      const resolveRelease = vi.fn(async () => version)
      expect(await detectVersion(config, client, resolveRelease)).toMatchObject(
        {
          detectedVersion: version,
          detectedReleaseSha: release,
          versionSource: "github-tags",
        },
      )
      expect(resolveRelease).toHaveBeenCalledWith(release)
    },
  )

  it("retains an API build SHA when HTML detection is unavailable", async () => {
    const config = testConfig()
    const release = "c".repeat(40)
    const client = new SentryApiClient(
      config,
      mockFetch((url) =>
        url.pathname === "/api/0/"
          ? jsonResponse({ version: { current: "0", build: release } })
          : jsonResponse({}, { status: 503 }),
      ),
    )
    const resolveRelease = vi.fn(async () => "27.1.0")
    expect(await detectVersion(config, client, resolveRelease)).toMatchObject({
      detectedVersion: "27.1.0",
      versionSource: "github-tags",
    })
    expect(resolveRelease).toHaveBeenCalledWith(release)
  })

  it("reports an unknown version when a SHA cannot be resolved", async () => {
    const config = testConfig()
    const release = "d".repeat(40)
    const client = new SentryApiClient(
      config,
      mockFetch((url) =>
        url.pathname === "/api/0/"
          ? jsonResponse({ version: "0" })
          : new Response(JSON.stringify({ release }), {
              headers: { "content-type": "text/html" },
            }),
      ),
    )
    expect(
      await detectVersion(config, client, async () => undefined),
    ).toMatchObject({
      detectedVersion: undefined,
      detectedReleaseSha: release,
      versionSource: "unknown",
    })
  })

  it("keeps API version 0 unknown when bootstrap has no application release", async () => {
    const config = testConfig()
    const client = new SentryApiClient(
      config,
      mockFetch(() => jsonResponse({ version: "0" })),
    )
    expect(
      (await detectVersion(config, client)).detectedVersion,
    ).toBeUndefined()
  })

  it("detects version from authenticated /api/0/ payload", async () => {
    const config = testConfig()
    const client = new SentryApiClient(
      config,
      mockFetch((url) => {
        if (url.pathname === "/api/0/") {
          return jsonResponse({
            version: { current: "26.7.2", latest: "26.8.0", build: "26.7.2" },
          })
        }
        return jsonResponse({})
      }),
    )
    const resolveRelease = vi.fn()
    const result = await detectVersion(config, client, resolveRelease)
    expect(resolveRelease).not.toHaveBeenCalled()
    expect(result.detectedVersion).toBe("26.7.2")
    expect(result.versionSource).toBe("bootstrap")
  })

  it("falls back to HTML bootstrap when /api/0/ does not provide version", async () => {
    const config = testConfig()
    const client = new SentryApiClient(
      config,
      mockFetch((url) => {
        if (url.pathname === "/api/0/") {
          return jsonResponse({ version: "0" })
        }
        if (url.pathname === "/") {
          return new Response('{"sentryVersion":"26.7.0"}', {
            headers: { "content-type": "text/html" },
          })
        }
        return jsonResponse({})
      }),
    )
    const result = await detectVersion(config, client)
    expect(result.detectedVersion).toBe("26.7.0")
    expect(result.versionSource).toBe("bootstrap")
  })
})
