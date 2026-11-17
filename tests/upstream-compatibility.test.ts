import { afterEach, describe, expect, it, vi } from "vitest"
import { upstreamTools, type ServerContext } from "../src/upstream.ts"
import { jsonResponse, mockFetch } from "./helpers.ts"

const context: ServerContext = {
  accessToken: "fake-token-value",
  sentryHost: "sentry.example.test",
  sentryProtocol: "https",
  grantedSkills: new Set(["inspect"]),
  constraints: {
    organizationSlug: "example-org",
    projectSlug: null,
  },
  transport: "http",
}

describe("pinned upstream Sentry issue API compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("runs core issue and issue-event searches without events/validate", async () => {
    const paths: string[] = []
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        paths.push(url.pathname)
        if (url.pathname.endsWith("/issues/")) {
          return jsonResponse([
            {
              id: "123",
              shortId: "EXAMPLE-123",
              title: "Fixture Error",
              status: "unresolved",
              count: "2",
              userCount: 1,
              firstSeen: "2026-05-27T10:00:00Z",
              lastSeen: "2026-05-27T12:00:00Z",
              permalink:
                "https://sentry.example.test/organizations/example-org/issues/123/",
              project: {
                id: "456",
                slug: "example-project",
                name: "Example Project",
              },
              culprit: "fixture.operation",
            },
          ])
        }
        if (url.pathname.endsWith("/issues/EXAMPLE-123/events/")) {
          return jsonResponse([
            {
              id: "event-1",
              timestamp: "2026-05-27T12:00:00Z",
              title: "Fixture Event",
            },
          ])
        }
        return jsonResponse(
          { detail: "fixture route missing" },
          { status: 404 },
        )
      }),
    )

    const issues = await upstreamTools.search_issues.handler(
      {
        organizationSlug: "example-org",
        query: "is:unresolved",
        sort: "date",
        period: "14d",
        projectSlugOrId: null,
        regionUrl: null,
        limit: 10,
        includeExplanation: false,
      },
      context,
    )
    const events = await upstreamTools.search_issue_events.handler(
      {
        organizationSlug: "example-org",
        issueId: "EXAMPLE-123",
        query: "environment:fixture",
        sort: "-timestamp",
        period: "14d",
        projectSlug: null,
        regionUrl: null,
        limit: 50,
        includeExplanation: false,
      },
      context,
    )

    expect(JSON.stringify(issues)).toContain("Fixture Error")
    expect(JSON.stringify(events)).toContain("Fixture Event")
    expect(paths).toContain("/api/0/organizations/example-org/issues/")
    expect(paths).toContain(
      "/api/0/organizations/example-org/issues/EXAMPLE-123/events/",
    )
    expect(paths.some((path) => path.includes("/events/validate/"))).toBe(false)
  })
})
