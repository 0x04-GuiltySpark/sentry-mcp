import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { metricMonitor } from "../../mcp-core/src/test-utils/metric-monitor.ts"
import { createRuntime } from "../src/app.ts"
import {
  MANAGEMENT_TOOLS,
  MANAGEMENT_READ_TOOLS,
} from "../src/management-policy.ts"
import {
  credentialResponse,
  INSPECT_SCOPES,
  jsonResponse,
  mockFetch,
} from "./helpers.ts"

const FULL_SCOPES = [
  ...INSPECT_SCOPES,
  "event:write",
  "alerts:write",
  "project:write",
  "team:write",
  "member:write",
  "org:write",
]
const project = {
  id: "100",
  slug: "example-project",
  name: "Example",
  platform: "python",
}
const teams = [
  { id: "1", slug: "ops", name: "Ops" },
  { id: "2", slug: "other", name: "Other" },
]
const key = {
  id: "7",
  name: "Default",
  dsn: { public: "https://public@example.test/100" },
  isActive: true,
  dateCreated: null,
}
const uptime = {
  id: "9",
  projectSlug: project.slug,
  name: "Health",
  status: "disabled",
  url: "https://example.test/health",
  intervalSeconds: 60,
  timeoutMs: 5000,
}

async function fixture(
  options: {
    scopes?: string[]
    projectSlug?: string
    onWrite?: (url: URL, init: RequestInit) => Response | Promise<Response>
    sharedAlert?: boolean
    legacyAlertScope?: boolean
  } = {},
) {
  const writes: { path: string; method: string; body: unknown }[] = []
  const scopes = options.scopes ?? [...FULL_SCOPES]
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.pathname === "/api/0/") return credentialResponse(scopes)
      const method = init?.method ?? "GET"
      if (method !== "GET" && method !== "HEAD") {
        writes.push({
          path: url.pathname,
          method,
          body: init?.body ? JSON.parse(init.body as string) : null,
        })
        return options.onWrite
          ? options.onWrite(url, init!)
          : jsonResponse(
              { detail: "Fixture denies this write" },
              { status: 403 },
            )
      }
      if (options.legacyAlertScope && url.pathname.endsWith("/project-scope/"))
        return jsonResponse(null, { status: 404 })
      if (options.legacyAlertScope && url.pathname.includes("/detectors/"))
        return jsonResponse({
          ...metricMonitor,
          projectId: options.sharedAlert ? "200" : "100",
        })
      if (url.pathname.endsWith("/project-scope/"))
        return jsonResponse({
          projectIds: options.sharedAlert ? ["100", "200"] : ["100"],
          includesAllProjects: false,
        })
      if (url.pathname.endsWith("/teams/")) return jsonResponse(teams)
      if (url.pathname.endsWith("/keys/")) return jsonResponse([key])
      if (url.pathname.includes("/detectors/"))
        return jsonResponse(metricMonitor)
      if (url.pathname.includes("/workflows/"))
        return jsonResponse({
          id: "9",
          name: "Notifications",
          enabled: false,
          detectorIds: options.legacyAlertScope ? ["123"] : [],
          actionFilters: [],
          config: { frequency: 30 },
        })
      if (url.pathname.includes("/uptime/")) return jsonResponse(uptime)
      return jsonResponse(project)
    }),
  )
  const runtime = createRuntime({
    SENTRY_HOST: "sentry.example.test",
    SENTRY_ACCESS_TOKEN: "fake-token",
    SENTRY_ORG_SLUG: "example-org",
    ...(options.projectSlug
      ? { SENTRY_PROJECT_SLUG: options.projectSlug }
      : {}),
  })
  const server = await runtime.createSessionServer()
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "project-management-test", version: "1" })
  await server.connect(st)
  await client.connect(ct)
  return {
    client,
    runtime,
    writes,
    scopes,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe("scope-driven project management", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(
      globalThis,
      Symbol.for("streaming-tech.sentry.fetchDeadlineInstalled"),
    )
  })

  it("exposes reviewed management and lookup tools with a full token", async () => {
    const f = await fixture()
    try {
      const names = (await f.client.listTools()).tools.map((tool) => tool.name)
      for (const name of [
        ...MANAGEMENT_TOOLS,
        ...MANAGEMENT_READ_TOOLS,
        "find_members",
        "find_team_members",
        "add_member_to_team",
        "remove_member_from_team",
        "update_member_team_role",
        "update_team",
      ])
        expect(names).toContain(name)
      expect(names).not.toContain("execute_sentry_tool")
      expect(names).not.toContain("analyze_issue_with_seer")
      expect(f.runtime.serverInfo.current().enabledSkills).toContain(
        "project-management",
      )
    } finally {
      await f.close()
    }
  })

  it("keeps a read-only token free of write tools", async () => {
    const f = await fixture({ scopes: [...INSPECT_SCOPES] })
    try {
      expect(
        (await f.client.listTools()).tools.every(
          (tool) => tool.annotations?.readOnlyHint,
        ),
      ).toBe(true)
      const result = await f.client
        .callTool({ name: "create_team", arguments: { name: "Ops" } })
        .catch(() => null)
      expect(result === null || result.isError).toBeTruthy()
      expect(f.writes).toEqual([])
    } finally {
      await f.close()
    }
  })

  it("exposes only alert writes when only that write category is granted", async () => {
    const f = await fixture({ scopes: [...INSPECT_SCOPES, "alerts:write"] })
    try {
      const names = (await f.client.listTools()).tools.map((tool) => tool.name)
      expect(names).toContain("create_alert_rule")
      expect(names).toContain("create_metric_monitor")
      for (const name of [
        "create_team",
        "update_project",
        "update_issue",
        "add_member_to_team",
        "create_dsn",
      ])
        expect(names).not.toContain(name)
    } finally {
      await f.close()
    }
  })

  it("accepts organisation-write permission for team membership without team-write", async () => {
    const f = await fixture({
      scopes: [...INSPECT_SCOPES, "org:write"],
      onWrite: () => jsonResponse({ isActive: true }),
    })
    try {
      const names = (await f.client.listTools()).tools.map((tool) => tool.name)
      expect(names).toContain("add_member_to_team")
      expect(names).not.toContain("create_team")
      const result = await f.client.callTool({
        name: "add_member_to_team",
        arguments: { memberId: "5", teamSlug: "ops" },
      })
      expect(result.isError).not.toBe(true)
      expect(f.writes).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  it("hides organisation-wide writes in a project-constrained session", async () => {
    const f = await fixture({ projectSlug: project.slug })
    try {
      const names = (await f.client.listTools()).tools.map((tool) => tool.name)
      for (const name of [
        "create_project",
        "create_team",
        "update_team",
        "add_member_to_team",
        "remove_member_from_team",
        "update_member_team_role",
      ])
        expect(names).not.toContain(name)
      expect(names).toContain("update_project")
      expect(names).toContain("create_alert_rule")
    } finally {
      await f.close()
    }
  })

  it.each([
    [
      "create_project",
      { teamSlug: "ops", name: "Example", slug: project.slug },
      "POST",
      "/teams/example-org/ops/projects/",
    ],
    [
      "update_project",
      { projectSlug: project.slug, name: "Renamed" },
      "PUT",
      "/projects/example-org/example-project/",
    ],
    [
      "create_team",
      { name: "Ops" },
      "POST",
      "/organizations/example-org/teams/",
    ],
    [
      "add_team_to_project",
      { projectSlug: project.slug, teamSlug: "third" },
      "POST",
      "/projects/example-org/example-project/teams/third/",
    ],
    [
      "remove_team_from_project",
      { projectSlug: project.slug, teamSlug: "ops" },
      "DELETE",
      "/projects/example-org/example-project/teams/ops/",
    ],
    [
      "create_alert_rule",
      {
        name: "Alerts",
        detectorIds: [],
        actionFilters: [],
        status: "disabled",
      },
      "POST",
      "/organizations/example-org/workflows/",
    ],
    [
      "update_alert_rule",
      { ruleIdOrName: "9", name: "Renamed" },
      "PUT",
      "/organizations/example-org/workflows/9/",
    ],
    [
      "delete_alert_rule",
      { ruleId: "9" },
      "DELETE",
      "/organizations/example-org/workflows/9/",
    ],
    [
      "create_monitor",
      {
        projectSlug: project.slug,
        name: "Cron",
        schedule: { type: "crontab", crontab: "0 3 * * *" },
      },
      "POST",
      "/organizations/example-org/projects/example-project/detectors/",
    ],
    [
      "create_metric_monitor",
      {
        projectSlug: project.slug,
        name: "Metric",
        query: {
          dataset: "events",
          query: "level:error",
          aggregate: "count()",
          eventTypes: ["error"],
          timeWindowSeconds: 3600,
        },
        config: { detectionType: "static" },
        conditionGroup: {
          id: metricMonitor.conditionGroup.id,
          conditions: metricMonitor.conditionGroup.conditions,
        },
      },
      "POST",
      "/organizations/example-org/projects/example-project/detectors/",
    ],
    [
      "update_metric_monitor",
      { monitorId: "123", name: "Renamed" },
      "PUT",
      "/organizations/example-org/detectors/123/",
    ],
    [
      "delete_metric_monitor",
      { monitorId: "123" },
      "DELETE",
      "/organizations/example-org/detectors/123/",
    ],
    [
      "delete_monitor_environment",
      { projectSlug: project.slug, monitorSlug: "cron", environment: "prod" },
      "DELETE",
      "/projects/example-org/example-project/monitors/cron/environments/prod/",
    ],
    [
      "create_uptime_monitor",
      {
        projectSlug: project.slug,
        name: "Health",
        url: uptime.url,
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
      "POST",
      "/projects/example-org/example-project/uptime/",
    ],
    [
      "update_uptime_monitor",
      { projectSlug: project.slug, uptimeMonitorId: "9", status: "disabled" },
      "PUT",
      "/projects/example-org/example-project/uptime/9/",
    ],
    [
      "delete_uptime_monitor",
      { projectSlug: project.slug, uptimeMonitorId: "9" },
      "DELETE",
      "/projects/example-org/example-project/uptime/9/",
    ],
    [
      "create_dsn",
      { projectSlug: project.slug, name: "SDK" },
      "POST",
      "/projects/example-org/example-project/keys/",
    ],
    [
      "update_dsn",
      { projectSlug: project.slug, keyId: "7", name: "SDK" },
      "PUT",
      "/projects/example-org/example-project/keys/7/",
    ],
  ] as const)(
    "routes %s to its reviewed endpoint and surfaces a denied write without replay",
    async (name, args, method, path) => {
      const f = await fixture()
      try {
        const result = await f.client.callTool({ name, arguments: args })
        expect(f.writes, JSON.stringify(result)).toMatchObject([
          { method, path: `/api/0${path}` },
        ])
        expect(f.writes).toHaveLength(1)
        expect(result.isError).toBe(true)
      } finally {
        await f.close()
      }
    },
  )

  it.each([
    ["add_member_to_team", { memberId: "5", teamSlug: "ops" }, "POST", null],
    [
      "remove_member_from_team",
      { memberId: "5", teamSlug: "ops" },
      "DELETE",
      null,
    ],
    [
      "update_member_team_role",
      { memberId: "5", teamSlug: "ops", teamRole: "admin" },
      "PUT",
      { teamRole: "admin" },
    ],
  ] as const)(
    "executes scoped membership operation %s",
    async (name, args, method, body) => {
      const f = await fixture({
        onWrite: () =>
          jsonResponse(
            { isActive: true, teamRole: "contributor" },
            { status: 200 },
          ),
      })
      try {
        const result = await f.client.callTool({ name, arguments: args })
        expect(result.isError).not.toBe(true)
        expect(f.writes).toEqual([
          {
            method,
            path: "/api/0/organizations/example-org/members/5/teams/ops/",
            body,
          },
        ])
      } finally {
        await f.close()
      }
    },
  )

  it.each([
    [
      "create_team",
      { name: "Ops" },
      { id: "1", slug: "ops", name: "Ops" },
      "/api/0/organizations/example-org/teams/",
    ],
    [
      "update_project",
      { projectSlug: project.slug, name: "Renamed" },
      { ...project, name: "Renamed" },
      "/api/0/projects/example-org/example-project/",
    ],
    [
      "update_team",
      { teamSlug: "ops", name: "Renamed" },
      { id: "1", slug: "ops", name: "Renamed" },
      "/api/0/teams/example-org/ops/",
    ],
    [
      "create_alert_rule",
      {
        name: "Notifications",
        detectorIds: [],
        actionFilters: [],
        status: "disabled",
      },
      {
        id: "9",
        name: "Notifications",
        enabled: false,
        detectorIds: [],
        actionFilters: [],
        config: { frequency: 30 },
      },
      "/api/0/organizations/example-org/workflows/",
    ],
  ] as const)(
    "returns a successful %s result",
    async (name, args, response, path) => {
      const f = await fixture({ onWrite: () => jsonResponse(response) })
      try {
        const result = await f.client.callTool({ name, arguments: args })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        expect(f.writes).toHaveLength(1)
        expect(f.writes[0]?.path).toBe(path)
      } finally {
        await f.close()
      }
    },
  )

  it("keeps constraint overrides on the configured resource and refuses a foreign origin", async () => {
    const f = await fixture({
      projectSlug: project.slug,
      onWrite: () => jsonResponse({ ...project, name: "Renamed" }),
    })
    try {
      for (const args of [
        { organizationSlug: "other-org" },
        { projectSlug: "other-project" },
      ]) {
        const result = await f.client.callTool({
          name: "update_project",
          arguments: { projectSlug: project.slug, name: "Renamed", ...args },
        })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
      }
      const foreign = await f.client.callTool({
        name: "update_project",
        arguments: { name: "Renamed", regionUrl: "https://outside.test" },
      })
      expect(foreign.isError).toBe(true)
      expect(f.writes).toHaveLength(2)
      expect(
        f.writes.every(
          (write) =>
            write.path === "/api/0/projects/example-org/example-project/",
        ),
      ).toBe(true)
    } finally {
      await f.close()
    }
  })

  it("reports a pending membership request accurately", async () => {
    const f = await fixture({
      onWrite: () => jsonResponse({}, { status: 202 }),
    })
    try {
      const result = await f.client.callTool({
        name: "add_member_to_team",
        arguments: { memberId: "5", teamSlug: "ops" },
      })
      expect(JSON.stringify(result)).toContain("pending")
    } finally {
      await f.close()
    }
  })

  it("refuses deletion of a shared alert in a constrained session", async () => {
    const f = await fixture({ projectSlug: project.slug, sharedAlert: true })
    try {
      const result = await f.client.callTool({
        name: "delete_alert_rule",
        arguments: { ruleId: "9" },
      })
      expect(result.isError).toBe(true)
      expect(f.writes).toEqual([])
    } finally {
      await f.close()
    }
  })

  it.each([undefined, project.slug])(
    "reads alert details with a missing native scope API (project %s)",
    async (projectSlug) => {
      const f = await fixture({ legacyAlertScope: true, projectSlug })
      try {
        const result = await f.client.callTool({
          name: "get_alert_rule",
          arguments: { kind: "issue", ruleIdOrName: "9" },
        })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        expect(result.structuredContent).toMatchObject({
          alertRule: {
            scope: { projectIds: ["100"], includesAllProjects: false },
          },
        })
        expect(f.writes).toEqual([])
      } finally {
        await f.close()
      }
    },
  )

  it.each(["update_alert_rule", "delete_alert_rule"])(
    "executes %s after verifying project scope via fallback",
    async (name) => {
      const f = await fixture({
        legacyAlertScope: true,
        projectSlug: project.slug,
        onWrite: () =>
          jsonResponse({
            id: "9",
            name: "Renamed",
            enabled: false,
            detectorIds: ["123"],
            actionFilters: [],
            config: { frequency: 30 },
          }),
      })
      try {
        const result = await f.client.callTool({
          name,
          arguments:
            name === "update_alert_rule"
              ? { ruleIdOrName: "9", name: "Renamed" }
              : { ruleId: "9" },
        })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        expect(f.writes).toHaveLength(1)
        expect(f.writes[0]?.path).toBe(
          "/api/0/organizations/example-org/workflows/9/",
        )
      } finally {
        await f.close()
      }
    },
  )

  it("refuses a foreign-project alert write using the fallback", async () => {
    const f = await fixture({
      legacyAlertScope: true,
      sharedAlert: true,
      projectSlug: project.slug,
    })
    try {
      const result = await f.client.callTool({
        name: "delete_alert_rule",
        arguments: { ruleId: "9" },
      })
      expect(result.isError).toBe(true)
      expect(f.writes).toEqual([])
    } finally {
      await f.close()
    }
  })

  it("rechecks revoked management permissions before any write", async () => {
    const scopes = [...FULL_SCOPES]
    const f = await fixture({ scopes })
    try {
      scopes.splice(scopes.indexOf("alerts:write"), 1)
      const result = await f.client.callTool({
        name: "delete_alert_rule",
        arguments: { ruleId: "9" },
      })
      expect(result.isError).toBe(true)
      expect(f.writes).toEqual([])
    } finally {
      await f.close()
    }
  })
})
