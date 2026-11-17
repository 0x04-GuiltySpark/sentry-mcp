import { randomUUID } from "node:crypto"
import express, { type Response } from "express"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { parseConfig, type WrapperConfig } from "./config.ts"
import { redactErrorMessage } from "./security/redact.ts"
import { SentryApiClient } from "./sentry-api-client.ts"
import { ServerInfoStore } from "./server-info.ts"
import { createWrapperTools } from "./tools/index.ts"
import { createUpstreamServer } from "./upstream-adapter.ts"
import { installUpstreamSentryDeadline } from "./upstream-deadline.ts"
import { resolveAlertScopeCompatibility } from "./compatibility/alert-scope.ts"
import {
  setAgentProvider,
  setProviderBaseUrls,
  type ServerContext,
} from "./upstream.ts"

export interface WrapperRuntime {
  config: WrapperConfig
  serverInfo: ServerInfoStore
  createSessionServer: () =>
    | ReturnType<typeof createUpstreamServer>
    | Promise<ReturnType<typeof createUpstreamServer>>
}

export function createRuntime(
  env: NodeJS.ProcessEnv = process.env,
): WrapperRuntime {
  const config = parseConfig(env)
  const agentProvider = env.EMBEDDED_AGENT_PROVIDER
  if (agentProvider) setAgentProvider(agentProvider as any)
  setProviderBaseUrls({
    openaiBaseUrl: env.OPENAI_BASE_URL,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
  })

  installUpstreamSentryDeadline(
    config.sentryOrigin,
    config.apiTimeoutMs,
    (url, response) =>
      resolveAlertScopeCompatibility(client, config, url, response),
  )
  const client = new SentryApiClient(config)
  const serverInfo = new ServerInfoStore(config, client)
  const wrapperTools = createWrapperTools({ config, client, serverInfo })

  const context: ServerContext = {
    accessToken: config.accessToken,
    sentryHost: config.sentryHost,
    sentryProtocol: config.sentryProtocol,
    grantedSkills: new Set(["inspect", "triage", "project-management"]),
    constraints: {
      organizationSlug: config.organizationSlug,
      projectSlug: config.projectSlug ?? null,
    },
    transport: "http",
  }

  return {
    config,
    serverInfo,
    createSessionServer: async () => {
      await client.permissions.refresh()
      return createUpstreamServer({
        context,
        wrapperTools,
        serverInfo: serverInfo.current(),
        experimentalMode: env.EXPERIMENTAL_MODE === "true",
        permissions: client.permissions,
        operationTimeoutMs: config.apiTimeoutMs,
      })
    },
  }
}

function isInitializeRequest(body: unknown): boolean {
  if (!body) return false
  if (Array.isArray(body)) {
    return body.some(
      (item) =>
        item &&
        typeof item === "object" &&
        "method" in item &&
        (item as { method?: string }).method === "initialize",
    )
  }
  return (
    typeof body === "object" &&
    body !== null &&
    "method" in body &&
    (body as { method?: string }).method === "initialize"
  )
}

async function withOperationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function sendMcpErrorResponse(res: Response, message: string): void {
  if (!res.headersSent) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: message.includes("wrapper deadline")
          ? `${message}; call sentry_server_info before retrying`
          : "Internal server error",
      },
      id: null,
    })
    return
  }
  res.end()
}

export function createApp(runtime: WrapperRuntime) {
  const app = express()
  app.use(express.json({ limit: "1mb" }))

  type SessionServer = Awaited<ReturnType<typeof runtime.createSessionServer>>
  const sessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport
      server: SessionServer
    }
  >()

  app.get("/health", (_req, res) => {
    const info = runtime.serverInfo.current()
    res.status(200).json({
      status: "ok",
      wrapperVersion: info.wrapperVersion,
      upstreamMcpRef: info.upstreamMcpRef,
      compatibilityProfile: info.compatibilityProfile,
      sentryReachability: info.capabilities.apiRoot.state,
      capabilitiesCheckedAt: info.checkedAt ?? null,
    })
  })

  app.all("/mcp", async (req, res) => {
    try {
      const sessionId = req.header("mcp-session-id")
      let transport: StreamableHTTPServerTransport | undefined
      let sessionServer: SessionServer | undefined

      if (sessionId) transport = sessions.get(sessionId)?.transport

      if (sessionId && !transport) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message:
              "Session expired; initialise a new MCP session without a session ID",
          },
          id: null,
        })
        return
      }

      if (
        !transport &&
        req.method === "POST" &&
        isInitializeRequest(req.body)
      ) {
        sessionServer = await runtime.createSessionServer()
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        })
        transport.onclose = () => {
          const activeSessionId = transport?.sessionId
          if (activeSessionId) sessions.delete(activeSessionId)
        }
        await sessionServer.connect(transport)
      }

      if (!transport) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Session ID required; initialise a new MCP session",
          },
          id: null,
        })
        return
      }

      const operation = transport.handleRequest(req, res, req.body)
      if (req.method === "GET") {
        // Notification streams stay open until the client disconnects.
        await operation
      } else {
        await withOperationTimeout(
          operation,
          runtime.config.apiTimeoutMs,
          `MCP operation exceeded the ${runtime.config.apiTimeoutMs}ms wrapper deadline`,
        )
      }

      const activeSessionId = transport.sessionId
      if (activeSessionId && sessionServer && !sessions.has(activeSessionId)) {
        sessions.set(activeSessionId, {
          transport,
          server: sessionServer,
        })
      }
    } catch (error) {
      const message = redactErrorMessage(error, runtime.config.accessToken)
      console.error(
        `[${new Date().toISOString()}] MCP HTTP error (${req.method}): ${message}`,
      )
      sendMcpErrorResponse(res, message)
    }
  })

  return app
}
