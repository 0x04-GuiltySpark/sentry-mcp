import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Response } from "express"
import { describe, expect, it, vi } from "vitest"
import { createApp, sendMcpErrorResponse } from "../src/app.ts"
import { SentryApiClient } from "../src/sentry-api-client.ts"
import { ServerInfoStore } from "../src/server-info.ts"
import { createUpstreamServer } from "../src/upstream-adapter.ts"
import {
  credentialResponse,
  jsonResponse,
  mockFetch,
  testConfig,
} from "./helpers.ts"

async function startHttpFixture() {
  const config = { ...testConfig(), apiTimeoutMs: 100 }
  const api = new SentryApiClient(
    config,
    mockFetch((url) =>
      url.pathname === "/api/0/" ? credentialResponse() : jsonResponse([]),
    ),
  )
  await api.permissions.refresh()
  const serverInfo = new ServerInfoStore(config, api)
  let releaseTool = () => {}
  const toolResult = new Promise<string>((resolve) => {
    releaseTool = () => resolve("finished")
  })
  const servers: ReturnType<typeof createUpstreamServer>[] = []
  const app = createApp({
    config,
    serverInfo,
    createSessionServer: () => {
      const server = createUpstreamServer({
        permissions: api.permissions,
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
        wrapperTools: {
          wrapper_test_slow: {
            name: "wrapper_test_slow",
            title: "Slow Fixture",
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: false,
            },
            description: "Wait for the test to release the result",
            inputSchema: {},
            skills: ["inspect"],
            requiredScopes: [],
            handler: async () => toolResult,
          },
        },
        serverInfo: serverInfo.current(),
      })
      servers.push(server)
      return server
    },
  })
  const httpServer = createServer(app)
  let getFinished = false
  const getStarted = new Promise<void>((resolve) => {
    httpServer.on("request", (req, res) => {
      if (req.method === "GET" && req.url === "/mcp") {
        res.on("finish", () => {
          getFinished = true
        })
        resolve()
      }
    })
  })
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve)
  })
  const address = httpServer.address()
  if (!address || typeof address === "string") throw new Error("Missing port")
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`)
  const transport = new StreamableHTTPClientTransport(url)
  const client = new Client({ name: "wrapper-http-test", version: "1.0.0" })
  await client.connect(transport)
  return {
    url,
    transport,
    client,
    getStarted,
    getFinished: () => getFinished,
    serverCount: () => servers.length,
    close: async () => {
      releaseTool()
      await client.close()
      await Promise.all(servers.map((server) => server.close()))
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()))
        httpServer.closeAllConnections()
      })
    },
  }
}

describe("MCP HTTP deadlines", () => {
  it("keeps idle GET streams open past the operation deadline", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const fixture = await startHttpFixture()
    try {
      await fixture.getStarted
      await delay(250)
      expect(fixture.getFinished()).toBe(false)
      const tools = await fixture.client.listTools()
      expect(
        tools.tools.some((tool) => tool.name === "wrapper_test_slow"),
      ).toBe(true)
      expect(errors).not.toHaveBeenCalled()
    } finally {
      await fixture.close()
      errors.mockRestore()
    }
  })

  it("still ends a stalled POST at the operation deadline", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const fixture = await startHttpFixture()
    try {
      const response = await fetch(fixture.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": fixture.transport.sessionId!,
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 900,
          method: "tools/call",
          params: { name: "wrapper_test_slow", arguments: {} },
        }),
        signal: AbortSignal.timeout(2_000),
      })
      expect(await response.text()).not.toContain("finished")
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining(
          "MCP HTTP error (POST): MCP operation exceeded the 100ms wrapper deadline",
        ),
      )
    } finally {
      await fixture.close()
      errors.mockRestore()
    }
  })
})

describe("MCP HTTP errors", () => {
  it.each(["GET", "POST", "DELETE"])(
    "returns 404 for an expired session on %s without creating a transport",
    async (method) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {})
      const fixture = await startHttpFixture()
      try {
        const before = fixture.serverCount()
        const response = await fetch(fixture.url, {
          method,
          headers: {
            "mcp-session-id": "expired-session",
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          ...(method === "POST"
            ? {
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 42,
                  method: "tools/call",
                  params: { name: "wrapper_test_slow", arguments: {} },
                }),
              }
            : {}),
          signal: AbortSignal.timeout(2000),
        })
        expect(response.status).toBe(404)
        expect(
          ((await response.json()) as { error: { message: string } }).error
            .message,
        ).toContain("initialise a new MCP session")
        expect(fixture.serverCount()).toBe(before)
        expect(errors).not.toHaveBeenCalled()
      } finally {
        await fixture.close()
        errors.mockRestore()
      }
    },
  )

  it("rejects uninitialised GET streams without allocating a session", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const fixture = await startHttpFixture()
    try {
      const before = fixture.serverCount()
      const response = await fetch(fixture.url, {
        headers: { accept: "text/event-stream" },
        signal: AbortSignal.timeout(2000),
      })
      expect(response.status).toBe(400)
      expect(fixture.serverCount()).toBe(before)
      expect(errors).not.toHaveBeenCalled()
    } finally {
      await fixture.close()
      errors.mockRestore()
    }
  })

  it("supports fresh initialisation after a session is terminated", async () => {
    const fixture = await startHttpFixture()
    const replacement = new Client({
      name: "replacement-session",
      version: "1",
    })
    const replacementTransport = new StreamableHTTPClientTransport(fixture.url)
    try {
      const expiredId = fixture.transport.sessionId!
      await fixture.transport.terminateSession()
      const response = await fetch(fixture.url, {
        headers: { "mcp-session-id": expiredId, accept: "text/event-stream" },
        signal: AbortSignal.timeout(2000),
      })
      expect(response.status).toBe(404)
      await replacement.connect(replacementTransport)
      expect(replacementTransport.sessionId).not.toBe(expiredId)
      expect(
        (await replacement.listTools()).tools.some(
          (tool) => tool.name === "wrapper_test_slow",
        ),
      ).toBe(true)
    } finally {
      await replacement.close()
      await fixture.close()
    }
  })

  it("ends an already-started response when the wrapper deadline expires", () => {
    const end = vi.fn()
    const res = {
      headersSent: true,
      end,
    } as unknown as Response

    sendMcpErrorResponse(
      res,
      "MCP operation exceeded the 20000ms wrapper deadline",
    )

    expect(end).toHaveBeenCalledOnce()
  })

  it("returns a JSON-RPC error before response headers are sent", () => {
    const json = vi.fn()
    const status = vi.fn(() => ({ json }))
    const res = {
      headersSent: false,
      status,
    } as unknown as Response

    sendMcpErrorResponse(
      res,
      "MCP operation exceeded the 20000ms wrapper deadline",
    )

    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining("call sentry_server_info"),
        }),
      }),
    )
  })
})
