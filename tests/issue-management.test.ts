import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRuntime } from "../src/app.ts"
import { SentryApiClient } from "../src/sentry-api-client.ts"
import {
  credentialResponse,
  INSPECT_SCOPES,
  jsonResponse,
  mockFetch,
  testConfig,
} from "./helpers.ts"

function issueFetch(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  scopes = [...INSPECT_SCOPES, "event:write"],
): typeof fetch {
  return mockFetch((url, init) =>
    url.pathname === "/api/0/"
      ? credentialResponse(scopes)
      : handler(url, init),
  )
}

async function connect(env: NodeJS.ProcessEnv = {}, scopes = INSPECT_SCOPES) {
  const original = globalThis.fetch
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) =>
      url.pathname === "/api/0/"
        ? credentialResponse(scopes)
        : original(url, init),
    ),
  )
  const runtime = createRuntime({
    SENTRY_HOST: "sentry.example.test",
    SENTRY_ORG_SLUG: "example-org",
    SENTRY_ACCESS_TOKEN: "fake-token-value",
    ...env,
  })
  const server = await runtime.createSessionServer()
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "issue-management-test", version: "1" })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    runtime,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe("configured issue management", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(
      globalThis,
      Symbol.for("streaming-tech.sentry.fetchDeadlineInstalled"),
    )
  })

  it("keeps only diagnostics available when scope discovery fails", async () => {
    vi.stubGlobal("fetch", vi.fn())
    const fixture = await connect({}, "malformed scopes" as never)
    try {
      const names = (await fixture.client.listTools()).tools
        .map((tool) => tool.name)
        .sort()
      expect(names).toEqual([
        "refresh_sentry_capabilities",
        "sentry_server_info",
      ])
      expect(fixture.runtime.serverInfo.current().tokenPermissions.status).toBe(
        "unavailable",
      )
    } finally {
      await fixture.close()
    }
  })

  it("withholds event tools from a project-only token", async () => {
    vi.stubGlobal("fetch", vi.fn())
    const fixture = await connect({}, ["project:read"])
    try {
      const names = (await fixture.client.listTools()).tools.map(
        (tool) => tool.name,
      )
      expect(names).toContain("find_projects")
      expect(names).not.toContain("search_issues")
      expect(names).not.toContain("update_issue")
      const result = await fixture.client
        .callTool({ name: "search_issues", arguments: {} })
        .catch(() => null)
      expect(result === null || result.isError).toBeTruthy()
    } finally {
      await fixture.close()
    }
  })

  it("rechecks a previously advertised write tool and denies a revoked grant", async () => {
    let writes = 0
    vi.stubGlobal(
      "fetch",
      issueFetch((_url, init) => {
        if (init?.method === "PUT") writes += 1
        return jsonResponse({ project: { slug: "example-project" } })
      }),
    )
    const scopes = [...INSPECT_SCOPES, "event:write"]
    const fixture = await connect({}, scopes)
    try {
      expect(
        (await fixture.client.listTools()).tools.map((tool) => tool.name),
      ).toContain("update_issue")
      scopes.splice(scopes.indexOf("event:write"), 1)
      const result = await fixture.client.callTool({
        name: "update_issue",
        arguments: { issueId: "123", status: "resolved" },
      })
      expect(result.isError).toBe(true)
      expect(writes).toBe(0)
    } finally {
      await fixture.close()
    }
  })

  it.each([
    ["text/html", "<html>Sign in</html>"],
    ["application/json", "[]"],
  ])(
    "does not confirm an update with an unexpected HTTP 200 response (%s)",
    async (contentType, body) => {
      vi.stubGlobal(
        "fetch",
        issueFetch((_url, init) =>
          init?.method === "PUT"
            ? new Response(body, { headers: { "content-type": contentType } })
            : jsonResponse({ project: { slug: "example-project" } }),
        ),
      )
      const fixture = await connect({}, [...INSPECT_SCOPES, "event:write"])
      try {
        const result = await fixture.client.callTool({
          name: "update_issue",
          arguments: { issueId: "123", status: "resolved" },
        })
        expect(result.isError).toBe(true)
      } finally {
        await fixture.close()
      }
    },
  )

  it("refuses a denied ownership lookup before sending any update", async () => {
    const fetch = vi.fn(
      issueFetch(() => jsonResponse({ detail: "Forbidden" }, { status: 403 })),
    )
    const client = new SentryApiClient(testConfig(), fetch)
    await expect(
      client.updateIssue("123", { priority: "high" }),
    ).rejects.toThrow("scope could not be verified")
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("times out a stalled write without retrying it", async () => {
    let writes = 0
    const client = new SentryApiClient(
      { ...testConfig(), apiTimeoutMs: 25 },
      issueFetch((_url, init) => {
        if (init?.method !== "PUT")
          return jsonResponse({ project: { slug: "example-project" } })
        writes += 1
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          )
        })
      }),
    )
    await expect(
      client.updateIssue("123", { status: "resolved" }),
    ).rejects.toThrow("timed out")
    expect(writes).toBe(1)
  })

  it("does not advertise or execute writes unless triage is selected", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const fixture = await connect()
    try {
      expect(
        (await fixture.client.listTools()).tools.map((tool) => tool.name),
      ).not.toContain("update_issue")
      const result = await fixture.client
        .callTool({
          name: "update_issue",
          arguments: { issueId: "123", status: "resolved" },
        })
        .catch(() => null)
      expect(result === null || result.isError).toBeTruthy()
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await fixture.close()
    }
  })

  it("updates status, assignment and priority together through MCP after project verification", async () => {
    const calls: { path: string; method: string; body?: string }[] = []
    vi.stubGlobal(
      "fetch",
      issueFetch((url, init) => {
        calls.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          body: init?.body as string | undefined,
        })
        return jsonResponse({
          id: "123",
          project: { slug: "example-project" },
          status: init?.method === "PUT" ? "resolved" : "unresolved",
        })
      }),
    )
    const fixture = await connect(
      {
        SENTRY_PROJECT_SLUG: "example-project",
      },
      [...INSPECT_SCOPES, "event:write"],
    )
    try {
      const tools = (await fixture.client.listTools()).tools
      expect(
        tools.find((tool) => tool.name === "update_issue")?.annotations
          ?.readOnlyHint,
      ).toBe(false)
      for (const excluded of [
        "execute_sentry_tool",
        "create_project",
        "analyze_issue_with_seer",
      ])
        expect(tools.map((tool) => tool.name)).not.toContain(excluded)
      expect(fixture.runtime.serverInfo.current().enabledSkills).toEqual([
        "inspect",
        "triage",
      ])
      const result = await fixture.client.callTool({
        name: "update_issue",
        arguments: {
          issueId: "123",
          status: "resolved",
          assignedTo: "user:42",
          priority: "high",
        },
      })
      expect(result.isError).not.toBe(true)
      expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"])
      expect(
        calls.every(
          (call) =>
            call.path === "/api/0/organizations/example-org/issues/123/",
        ),
      ).toBe(true)
      expect(JSON.parse(calls[1]!.body!)).toEqual({
        status: "resolved",
        assignedTo: "user:42",
        priority: "high",
      })
    } finally {
      await fixture.close()
    }
  })

  it.each([
    { priority: "low" as const },
    { assignedTo: null },
    { assignedTo: "team:ops" },
    { status: "unresolved" as const },
  ])("sends only the requested changes: %j", async (update) => {
    const bodies: unknown[] = []
    const client = new SentryApiClient(
      testConfig(),
      issueFetch((_url, init) => {
        if (init?.method === "PUT") bodies.push(JSON.parse(init.body as string))
        return jsonResponse({ project: { slug: "example-project" } })
      }),
    )
    await client.updateIssue("EXAMPLE-123", update)
    expect(bodies).toEqual([update])
  })

  it.each([{ project: { slug: "other-project" } }, {}])(
    "refuses to write when project ownership cannot be verified: %j",
    async (body) => {
      const fetch = vi.fn(issueFetch(() => jsonResponse(body)))
      const client = new SentryApiClient(
        testConfig({
          SENTRY_PROJECT_SLUG: "example-project",
        }),
        fetch,
      )
      await expect(
        client.updateIssue("123", { priority: "high" }),
      ).rejects.toThrow("scope")
      expect(fetch).toHaveBeenCalledTimes(2)
    },
  )

  it("rejects disabled writes, invalid identifiers, empty updates and unknown fields before fetching", async () => {
    const fetch = vi.fn()
    const inspect = new SentryApiClient(
      testConfig(),
      issueFetch(() => {
        throw new Error("must not read issue")
      }, INSPECT_SCOPES),
    )
    await expect(
      inspect.updateIssue("123", { status: "resolved" }),
    ).rejects.toThrow("permissions")
    const triage = new SentryApiClient(testConfig(), fetch)
    await expect(
      triage.updateIssue("../other", { priority: "high" }),
    ).rejects.toThrow()
    await expect(triage.updateIssue("123", {})).rejects.toThrow()
    await expect(
      triage.updateIssue("123", { discard: true } as never),
    ).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([403, 500, 307])(
    "does not retry or follow a failed update (HTTP %s)",
    async (status) => {
      let writes = 0
      vi.stubGlobal(
        "fetch",
        issueFetch((_url, init) => {
          if (init?.method !== "PUT")
            return jsonResponse({ project: { slug: "example-project" } })
          writes += 1
          return jsonResponse(
            { detail: "Denied" },
            {
              status,
              headers: {
                location: "/api/0/organizations/example-org/issues/456/",
              },
            },
          )
        }),
      )
      const fixture = await connect({}, [...INSPECT_SCOPES, "event:write"])
      try {
        const result = await fixture.client.callTool({
          name: "update_issue",
          arguments: { issueId: "123", priority: "medium" },
        })
        expect(result.isError).toBe(true)
        expect(writes).toBe(1)
      } finally {
        await fixture.close()
      }
    },
  )
})
