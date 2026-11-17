import { describe, expect, it } from "vitest"
import { DEFAULT_UPSTREAM_MCP_REF, parseConfig } from "../src/config.ts"

const required = {
  SENTRY_HOST: "sentry.example.test:8443",
  SENTRY_ACCESS_TOKEN: "fake-token",
  SENTRY_ORG_SLUG: "example-org",
}

describe("parseConfig", () => {
  it("uses package defaults and the pinned upstream commit", () => {
    const config = parseConfig(required)
    expect(config.sentryOrigin).toBe("https://sentry.example.test:8443")
    expect(config.upstreamMcpRef).toBe(DEFAULT_UPSTREAM_MCP_REF)
    expect(config.upstreamMcpRefSource).toBe("package-default")
    expect(config.apiTimeoutMs).toBe(60_000)
    expect(config.apiMaxResponseBytes).toBe(1_048_576)
    expect(config.apiMaxPages).toBe(5)
    expect(config.apiMaxItems).toBe(250)
  })

  it("accepts a full per-instance SHA and explicit insecure HTTP", () => {
    const ref = "a".repeat(40)
    const config = parseConfig({
      ...required,
      SENTRY_MCP_REF: ref,
      SENTRY_INSECURE_HTTP: "true",
      SENTRY_PROJECT_SLUG: "example-project",
    })
    expect(config.upstreamMcpRef).toBe(ref)
    expect(config.upstreamMcpRefSource).toBe("instance-override")
    expect(config.sentryOrigin).toBe("http://sentry.example.test:8443")
  })

  it.each([
    ["main"],
    ["master"],
    ["latest"],
    ["6e578191"],
    ["G".repeat(40)],
    ["A".repeat(40)],
  ])("rejects mutable, abbreviated, or invalid ref %s", (ref) => {
    expect(() => parseConfig({ ...required, SENTRY_MCP_REF: ref })).toThrow(
      /full lowercase 40-character/,
    )
  })

  it("rejects numeric settings outside the allowed range", () => {
    expect(() =>
      parseConfig({ ...required, SENTRY_API_TIMEOUT_MS: "999" }),
    ).toThrow(/between 1000 and 60000/)
    expect(() =>
      parseConfig({ ...required, SENTRY_API_TIMEOUT_MS: "60001" }),
    ).toThrow(/between 1000 and 60000/)
    expect(() =>
      parseConfig({ ...required, SENTRY_API_MAX_PAGES: "0" }),
    ).toThrow(/between 1 and 20/)
  })

  it("allows a shorter explicit timeout", () => {
    expect(
      parseConfig({ ...required, SENTRY_API_TIMEOUT_MS: "20000" }).apiTimeoutMs,
    ).toBe(20_000)
  })

  it("rejects URL-shaped hosts and missing credentials", () => {
    expect(() =>
      parseConfig({ ...required, SENTRY_HOST: "https://sentry.example.test" }),
    ).toThrow(/hostname/)
    expect(() => parseConfig({ ...required, SENTRY_ACCESS_TOKEN: "" })).toThrow(
      /required/,
    )
  })
})
