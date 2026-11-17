import { afterEach, describe, expect, it, vi } from "vitest"
import { SentryApiClient } from "../src/sentry-api-client.ts"
import { ServerInfoStore } from "../src/server-info.ts"
import { createMergedToolRegistry } from "../src/upstream-adapter.ts"
import type { ServerContext } from "../src/upstream.ts"
import { jsonResponse, mockFetch, testConfig } from "./helpers.ts"

const config = testConfig()
const context: ServerContext = {
  accessToken: config.accessToken,
  sentryHost: config.sentryHost,
  sentryProtocol: "https",
  grantedSkills: new Set(["inspect"]),
  constraints: { organizationSlug: "example-org", projectSlug: null },
  transport: "http",
}
const params = {
  organizationSlug: "example-org",
  regionUrl: null,
  projectSlug: null,
  query: "",
  fields: null,
  sort: null,
  period: "1h",
  limit: 1,
  includeExplanation: false,
  fresh: true,
}

// Source contract: getsentry/sentry src/sentry/search/events/datasets/profiles.py
// has blob 09727b3d0023bc23ae60551d6bcb194b02741588 at all three release tags.
// This deliberately models the actual /events/ rejection that validation misses.
const unsupportedProfileFields = [
  "profiler.id",
  "thread.id",
  "precise.start_ts",
  "precise.finish_ts",
]

describe("self-hosted Sentry dataset contract", () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(["profiles", "logs", "errors"])(
    "executes the %s query with default fields",
    async (dataset) => {
      let requestedFields: string[] = []
      vi.stubGlobal(
        "fetch",
        mockFetch((url) => {
          if (url.pathname.endsWith("/events/validate/"))
            return jsonResponse({
              valid: true,
              projects: [],
              dataset:
                dataset === "profiles"
                  ? [
                      {
                        valid: false,
                        name: "profiles",
                        error:
                          "Dataset profiles is not compatible with the validate endpoint",
                      },
                    ]
                  : [],
              environment: [],
              field: [],
              query: { valid: true, error: null, fields: [] },
              orderby: [],
            })
          if (url.pathname.endsWith("/events/")) {
            expect(url.searchParams.get("dataset")).toBe(dataset)
            expect(url.searchParams.get("statsPeriod")).toBe("1h")
            requestedFields = url.searchParams.getAll("field")
            if (
              dataset === "profiles" &&
              requestedFields.some((field) =>
                unsupportedProfileFields.includes(field),
              )
            ) {
              return jsonResponse(
                { detail: "Unknown column in profiles dataset" },
                { status: 400 },
              )
            }
            return jsonResponse({
              data: [
                {
                  "profile.id": "a".repeat(32),
                  timestamp: "2026-11-01T00:00:00Z",
                  transaction: "fixture.operation",
                  message: "fixture log",
                  title: "fixture error",
                },
              ],
            })
          }
          return jsonResponse(
            { detail: "fixture route missing" },
            { status: 404 },
          )
        }),
      )
      const info = new ServerInfoStore(
        config,
        new SentryApiClient(config),
      ).current()
      const tools = createMergedToolRegistry({}, info)
      const result = await tools[`search_${dataset}`]!.handler(params, context)
      expect(requestedFields.length).toBeGreaterThan(0)
      expect(result).toMatchObject({
        structuredContent: {
          executedSearch: { dataset },
          results: [
            {
              values:
                dataset === "profiles"
                  ? { "profile.id": "a".repeat(32) }
                  : dataset === "logs"
                    ? { message: "fixture log" }
                    : { title: "fixture error" },
            },
          ],
        },
      })
      if (dataset === "profiles") {
        expect(requestedFields).toContain("profile.id")
        for (const field of unsupportedProfileFields)
          expect(requestedFields).not.toContain(field)
      }
    },
  )

  it("preserves explicit fields and filters instead of silently changing a query", async () => {
    const calls: URL[] = []
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        calls.push(url)
        if (url.pathname.endsWith("/events/validate/"))
          return jsonResponse({
            valid: true,
            projects: [],
            dataset: [],
            environment: [],
            field: [],
            query: { valid: true, error: null, fields: [] },
            orderby: [],
          })
        if (url.pathname.endsWith("/events/")) return jsonResponse({ data: [] })
        return jsonResponse({})
      }),
    )
    const tools = createMergedToolRegistry(
      {},
      new ServerInfoStore(config, new SentryApiClient(config)).current(),
    )
    await tools.search_profiles!.handler(
      {
        ...params,
        query: "transaction:checkout",
        fields: ["profile.id", "timestamp"],
        sort: "-timestamp",
      },
      context,
    )
    const query = calls.find((url) => url.pathname.endsWith("/events/"))!
    expect(query.searchParams.get("query")).toBe("transaction:checkout")
    expect(query.searchParams.getAll("field")).toEqual([
      "profile.id",
      "timestamp",
    ])
    expect(query.searchParams.get("sort")).toBe("-timestamp")
  })
})
