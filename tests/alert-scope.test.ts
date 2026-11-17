import { describe, expect, it } from "vitest"
import { resolveAlertScopeCompatibility } from "../src/compatibility/alert-scope.ts"
import { SentryApiClient } from "../src/sentry-api-client.ts"
import { jsonResponse, mockFetch, testConfig } from "./helpers.ts"

const path = "/api/0/organizations/example-org/workflows/9/project-scope/"

function fixture(
  options: {
    projects?: (string | null)[]
    status?: number
    malformed?: boolean
    changed?: boolean
    limit?: string
    detectorStatus?: number
  } = {},
) {
  const config = testConfig({ SENTRY_API_MAX_ITEMS: options.limit ?? "250" })
  let workflowReads = 0
  const calls: string[] = []
  const projects = options.projects ?? ["100"]
  const client = new SentryApiClient(
    config,
    mockFetch((url) => {
      calls.push(url.pathname)
      if (url.pathname.endsWith("/workflows/9/")) {
        workflowReads++
        return jsonResponse({
          id: "9",
          ...(options.malformed
            ? {}
            : {
                detectorIds:
                  options.changed && workflowReads > 1
                    ? []
                    : projects.map((_, i) => String(i + 1)),
              }),
        })
      }
      const id = url.pathname.split("/").at(-2)!
      return jsonResponse(
        { id, projectId: projects[Number(id) - 1] },
        { status: options.detectorStatus ?? 200 },
      )
    }),
  )
  const response = jsonResponse({}, { status: options.status ?? 404 })
  return {
    client,
    config,
    calls,
    response,
    run: () =>
      resolveAlertScopeCompatibility(
        client,
        config,
        new URL(path, config.sentryOrigin),
        response,
      ),
  }
}

describe("alert scope API compatibility", () => {
  it.each([200, 401, 403, 429, 500])(
    "preserves native HTTP %s without falling back",
    async (status) => {
      const f = fixture({ status })
      expect(await f.run()).toBe(f.response)
      expect(f.calls).toEqual([])
    },
  )

  it.each([
    [[], { projectIds: [], includesAllProjects: false }],
    [["100", "100"], { projectIds: ["100"], includesAllProjects: false }],
    [
      ["100", "200"],
      { projectIds: ["100", "200"], includesAllProjects: false },
    ],
    [["100", null], { projectIds: [], includesAllProjects: true }],
  ])(
    "resolves all connections from the older workflow and detector APIs",
    async (projects, expected) => {
      const f = fixture({ projects: projects as (string | null)[] })
      expect(await (await f.run()).json()).toEqual(expected)
      expect(
        f.calls.filter((call) => call.endsWith("/workflows/9/")),
      ).toHaveLength(2)
    },
  )

  it.each([
    { malformed: true },
    { changed: true },
    { limit: "1", projects: ["100", "200"] },
    { detectorStatus: 403 },
    { detectorStatus: 404 },
  ])("refuses incomplete or changing scope evidence: %j", async (options) => {
    const f = fixture(options)
    await expect(f.run()).rejects.toThrow()
  })

  it("ignores other origins, organisations and paths", async () => {
    const f = fixture()
    for (const url of [
      new URL(path, "https://outside.test"),
      new URL(path.replace("example-org", "other"), f.config.sentryOrigin),
      new URL(`${path}?other=1`, f.config.sentryOrigin),
    ]) {
      expect(
        await resolveAlertScopeCompatibility(
          f.client,
          f.config,
          url,
          f.response,
        ),
      ).toBe(f.response)
    }
    expect(f.calls).toEqual([])
  })
})
