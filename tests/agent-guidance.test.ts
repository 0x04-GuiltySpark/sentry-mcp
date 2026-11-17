import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  API_FALLBACK_NOTICE,
  USAGE_RESOURCE_URI,
} from "../src/agent-guidance.ts"
import { SentryApiClient } from "../src/sentry-api-client.ts"
import { ServerInfoStore } from "../src/server-info.ts"
import { createWrapperTools } from "../src/tools/index.ts"
import { createUpstreamServer } from "../src/upstream-adapter.ts"
import {
  credentialResponse,
  INSPECT_SCOPES,
  jsonResponse,
  mockFetch,
  testConfig,
} from "./helpers.ts"

function text(result: Record<string, unknown>): string {
  return (result.content as { type: string; text: string }[])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
}

async function fixture(
  options: { scopes?: string[]; read?: (url: URL) => Response } = {},
) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const scopes = options.scopes ?? [...INSPECT_SCOPES]
  const config = testConfig()
  const paths: string[] = []
  const api = new SentryApiClient(
    config,
    mockFetch((url) => {
      if (url.pathname === "/api/0/") return credentialResponse(scopes)
      paths.push(url.pathname)
      return options.read?.(url) ?? jsonResponse([{ id: "1" }])
    }),
  )
  await api.permissions.refresh()
  const info = new ServerInfoStore(config, api)
  const server = createUpstreamServer({
    context: {
      accessToken: config.accessToken,
      sentryHost: config.sentryHost,
      sentryProtocol: config.sentryProtocol,
      grantedSkills: new Set(["inspect", "triage", "project-management"]),
      constraints: {
        organizationSlug: config.organizationSlug,
        projectSlug: null,
      },
      transport: "http",
    },
    wrapperTools: createWrapperTools({ config, client: api, serverInfo: info }),
    serverInfo: info.current(),
    permissions: api.permissions,
  })
  const client = new Client({ name: "agent-guidance-tests", version: "1" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  return {
    client,
    scopes,
    paths,
    warn,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe("protocol-visible agent guidance", () => {
  afterEach(() => vi.restoreAllMocks())

  it("publishes filtered routing, fallback reporting and a readable usage resource", async () => {
    const f = await fixture({ scopes: ["event:read"] })
    try {
      const instructions = f.client.getInstructions()!
      expect(instructions).toContain("Grouped issues: search_issues")
      expect(instructions).toContain("tell the operator in your response")
      expect(instructions).toContain("inspect MCP sidecar and Sentry logs")
      expect(instructions).not.toContain("update_issue")
      expect(instructions).not.toContain("find_teams")
      expect(instructions).not.toContain("get_sentry_resource")
      const resources = await f.client.listResources()
      expect(
        resources.resources.some(
          (resource) => resource.uri === USAGE_RESOURCE_URI,
        ),
      ).toBe(true)
      const guide = await f.client.readResource({ uri: USAGE_RESOURCE_URI })
      const content = guide.contents[0]!
      expect(content.mimeType).toBe("text/markdown")
      const markdown = "text" in content ? content.text : ""
      const listed = [...markdown.matchAll(/^- (\w+): /gm)]
        .map((match) => match[1])
        .sort()
      expect(listed).toEqual(
        (await f.client.listTools()).tools.map((tool) => tool.name).sort(),
      )
      expect(markdown).toContain("token-permission problem")
      expect(f.paths).toEqual([])
    } finally {
      await f.close()
    }
  })

  it("keeps fallback guidance in descriptions and schemas without extra required inputs", async () => {
    const f = await fixture()
    try {
      const tools = (await f.client.listTools()).tools
      for (const name of ["sentry_api_get", "sentry_api_paginate"]) {
        const tool = tools.find((tool) => tool.name === name)!
        expect(tool.description).toContain(
          "only when no dedicated tool can answer",
        )
        expect(tool.description).toContain("tell the operator in your response")
        expect(tool.description).toContain(
          "inspect MCP sidecar and Sentry logs",
        )
        expect(tool.inputSchema.required).toEqual(["path"])
        expect(tool.annotations?.readOnlyHint).toBe(true)
        expect(JSON.stringify(tool.inputSchema.properties?.path)).toContain(
          "without query or fragment",
        )
      }
      for (const tool of tools)
        expect(tool.description).not.toMatch(
          /get_sentry_resource|execute_sentry_tool|search_sentry_tools/,
        )
    } finally {
      await f.close()
    }
  })

  it.each(["sentry_api_get", "sentry_api_paginate"])(
    "retains the notice and existing data for %s",
    async (name) => {
      const f = await fixture()
      try {
        const result = await f.client.callTool({
          name,
          arguments: { path: "/api/0/organizations/example-org/projects/" },
        })
        const data = JSON.parse(text(result))
        expect(data.fallback).toEqual(API_FALLBACK_NOTICE)
        expect(name === "sentry_api_get" ? data.body : data.items).toEqual([
          { id: "1" },
        ])
        expect(name === "sentry_api_get" ? data.status : data.pageCount).toBe(
          name === "sentry_api_get" ? 200 : 1,
        )
        expect(f.warn).toHaveBeenCalledTimes(1)
        const log = JSON.parse(String(f.warn.mock.calls[0]![0]))
        expect(log.tool).toBe(name)
        expect(JSON.stringify(log)).not.toContain("fake-token")
      } finally {
        await f.close()
      }
    },
  )

  it.each(["sentry_api_get", "sentry_api_paginate"])(
    "includes operator reporting on failed %s calls",
    async (name) => {
      const f = await fixture({
        read: () => {
          throw new Error("fixture network failure")
        },
      })
      try {
        const result = await f.client.callTool({
          name,
          arguments: { path: "/api/0/organizations/example-org/projects/" },
        })
        const data = JSON.parse(text(result))
        expect(data.fallback).toEqual(API_FALLBACK_NOTICE)
        expect(data.error.message).toContain("fixture network failure")
      } finally {
        await f.close()
      }
    },
  )

  it.each(["sentry_api_get", "sentry_api_paginate"])(
    "preserves the notice when %s is denied before its handler",
    async (name) => {
      const f = await fixture()
      try {
        f.scopes.splice(0)
        const result = await f.client.callTool({
          name,
          arguments: { path: "/api/0/organizations/example-org/projects/" },
        })
        expect(result.isError).toBe(true)
        expect(JSON.parse(text(result)).fallback).toEqual(API_FALLBACK_NOTICE)
        expect(f.paths).toEqual([])
        expect(f.warn).toHaveBeenCalledTimes(1)
      } finally {
        await f.close()
      }
    },
  )

  it("does not turn a failed pagination page into ordinary result items", async () => {
    const f = await fixture({
      read: () => jsonResponse({ detail: "denied" }, { status: 403 }),
    })
    try {
      const result = await f.client.callTool({
        name: "sentry_api_paginate",
        arguments: { path: "/api/0/organizations/example-org/projects/" },
      })
      const data = JSON.parse(text(result))
      expect(data.fallback).toEqual(API_FALLBACK_NOTICE)
      expect(data.response.status).toBe(403)
      expect(data.error).toContain("Pagination stopped")
      expect(data.items).toBeUndefined()
    } finally {
      await f.close()
    }
  })

  it("retains scope restrictions on fallbacks", async () => {
    const f = await fixture()
    try {
      const result = await f.client.callTool({
        name: "sentry_api_get",
        arguments: { path: "/api/0/organizations/other/projects/" },
      })
      const data = JSON.parse(text(result))
      expect(data.fallback).toEqual(API_FALLBACK_NOTICE)
      expect(data.error.message).toContain("scope")
      expect(f.paths).toEqual([])
    } finally {
      await f.close()
    }
  })
})
