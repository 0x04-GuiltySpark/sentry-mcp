import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { describe, expect, it } from "vitest"
import { SentryApiClient } from "../src/sentry-api-client.ts"
import { ServerInfoStore } from "../src/server-info.ts"
import { createWrapperTools } from "../src/tools/index.ts"
import { createUpstreamServer } from "../src/upstream-adapter.ts"
import {
  credentialResponse,
  jsonResponse,
  mockFetch,
  testConfig,
} from "./helpers.ts"

describe("merged MCP registry", () => {
  it("lists the wrapper tools alongside upstream inspection tools", async () => {
    const config = testConfig()
    const client = new SentryApiClient(
      config,
      mockFetch((url) =>
        url.pathname === "/api/0/" ? credentialResponse() : jsonResponse([]),
      ),
    )
    const serverInfo = new ServerInfoStore(config, client)
    const wrapperTools = createWrapperTools({ config, client, serverInfo })
    await client.permissions.refresh()
    const server = createUpstreamServer({
      permissions: client.permissions,
      context: {
        accessToken: config.accessToken,
        sentryHost: config.sentryHost,
        sentryProtocol: config.sentryProtocol,
        grantedSkills: new Set(["inspect"]),
        constraints: {
          organizationSlug: config.organizationSlug,
          projectSlug: null,
        },
        transport: "http",
      },
      wrapperTools,
      serverInfo: serverInfo.current(),
    })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const mcpClient = new Client({
      name: "streaming-tech-wrapper-test",
      version: "1.0.0",
    })

    await server.connect(serverTransport)
    await mcpClient.connect(clientTransport)
    try {
      const tools = (await mcpClient.listTools()).tools
      const names = tools.map((tool) => tool.name)
      expect(names).toContain("sentry_server_info")
      expect(names).toContain("refresh_sentry_capabilities")
      expect(names).toContain("sentry_api_get")
      expect(names).toContain("sentry_api_paginate")
      expect(names).toContain("search_issues")
      for (const name of [
        "search_profiles",
        "search_logs",
        "search_errors",
        "get_profile_details",
      ])
        expect(names).toContain(name)
      for (const name of [
        "update_issue",
        "execute_sentry_tool",
        "search_sentry_tools",
        "analyze_issue_with_seer",
        "get_sentry_resource",
      ]) {
        expect(names).not.toContain(name)
        const result = await mcpClient
          .callTool({ name, arguments: {} })
          .catch(() => null)
        expect(result === null || result.isError === true).toBe(true)
      }
      expect(
        tools.every((tool) => tool.annotations?.readOnlyHint === true),
      ).toBe(true)

      const apiGet = tools.find((tool) => tool.name === "sentry_api_get")
      expect(apiGet?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      })
    } finally {
      await mcpClient.close()
      await server.close()
    }
  })
})
