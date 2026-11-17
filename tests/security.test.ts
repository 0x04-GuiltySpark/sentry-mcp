import { describe, expect, it } from "vitest"
import {
  assertConfiguredScope,
  validateApiPath,
  validateQuery,
} from "../src/security/validate-api-path.ts"
import { redactValue } from "../src/security/redact.ts"

const origin = "https://sentry.example.test"

describe("API path and query security", () => {
  it("accepts scoped read-only API paths", () => {
    expect(
      validateApiPath("/api/0/organizations/example-org/issues/", origin),
    ).toBe("/api/0/organizations/example-org/issues/")
    expect(
      assertConfiguredScope(
        "/api/0/organizations/example-org/issues/",
        {},
        "example-org",
      ),
    ).toEqual({})
  })

  it.each([
    "https://other.example/api/0/issues/",
    "//other.example/api/0/issues/",
    "/api/0/../admin/",
    "/api/0/%2e%2e/admin/",
    "/api/0/%252e%252e/admin/",
    "/api/0/issues%2f1/",
    "/api/0/issues/1/?download=1",
    "/api/0/issues/1/#fragment",
    "/api/1/issues/",
    "/api/0\\issues\\1",
  ])("rejects ambiguous or out-of-origin path %s", (path) => {
    expect(() => validateApiPath(path, origin)).toThrow()
  })

  it("rejects paths and queries outside configured scope", () => {
    expect(() =>
      assertConfiguredScope(
        "/api/0/organizations/other-org/issues/",
        {},
        "example-org",
      ),
    ).toThrow(/organization scope/)
    expect(() =>
      assertConfiguredScope(
        "/api/0/projects/example-org/other-project/events/",
        {},
        "example-org",
        "example-project",
      ),
    ).toThrow(/project scope/)
    expect(() =>
      assertConfiguredScope(
        "/api/0/organizations/example-org/issues/",
        { project: "other-project" },
        "example-org",
        "example-project",
      ),
    ).toThrow(/project scope/)
    expect(() =>
      assertConfiguredScope("/api/0/users/me/", {}, "example-org"),
    ).toThrow(/outside the configured Sentry scope/)
  })

  it("returns the issue ID so its organisation can be checked", () => {
    expect(
      assertConfiguredScope(
        "/api/0/issues/123/events/latest/",
        {},
        "example-org",
      ),
    ).toEqual({ issueId: "123" })
  })

  it("rejects secret-shaped and oversized query values", () => {
    expect(() => validateQuery({ access_token: "secret" })).toThrow(
      /not allowed/,
    )
    expect(() => validateQuery({ query: "x".repeat(4_097) })).toThrow(
      /invalid value/,
    )
  })

  it("redacts secret keys, bearer values, and the configured token", () => {
    expect(
      redactValue(
        {
          accessToken: "anything",
          nested: "Bearer abc.def and fake-token-value",
        },
        "fake-token-value",
      ),
    ).toEqual({
      accessToken: "[REDACTED]",
      nested: "Bearer [REDACTED] and [REDACTED]",
    })
  })
})
