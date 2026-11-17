import { z } from "zod"
import {
  API_FALLBACK_NOTICE,
  API_FALLBACK_POLICY,
  logApiFallback,
} from "../agent-guidance.ts"
import { createTeamManagementTools } from "./team-management.ts"
import type { WrapperConfig } from "../config.ts"
import type { ApiResponse, SentryApiClient } from "../sentry-api-client.ts"
import { SentryApiError } from "../sentry-api-client.ts"
import type { ServerInfoStore } from "../server-info.ts"
import type { ApiQuery } from "../security/validate-api-path.ts"
import { redactErrorMessage } from "../security/redact.ts"
import type { ToolConfig } from "../upstream.ts"
import {
  issueIdSchema,
  issueUpdateFields,
  type IssueUpdate,
} from "../issue-update.ts"

interface WrapperToolDependencies {
  config: WrapperConfig
  client: SentryApiClient
  serverInfo: ServerInfoStore
}

const querySchema = z
  .record(z.string(), z.union([z.string(), z.array(z.string())]))
  .optional()

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function errorResult(
  error: unknown,
  config: WrapperConfig,
  compatibilityProfile: string,
  path?: string,
): string {
  const message = redactErrorMessage(error, config.accessToken)
  return json({
    fallback: API_FALLBACK_NOTICE,
    error: {
      code: error instanceof SentryApiError ? error.code : "invalid-request",
      message,
      ...(path ? { method: "GET", path } : {}),
      timeoutMs: config.apiTimeoutMs,
      instance: config.organizationSlug,
      compatibilityProfile,
      suggestedNextOperation: "sentry_server_info",
    },
  })
}

function responseItems(response: ApiResponse): unknown[] {
  if (Array.isArray(response.body)) return response.body
  if (
    response.body &&
    typeof response.body === "object" &&
    Array.isArray((response.body as Record<string, unknown>).results)
  ) {
    return (response.body as { results: unknown[] }).results
  }
  return [response.body]
}

function parseNextPath(nextPath: string): {
  path: string
  query: ApiQuery
} {
  const separator = nextPath.indexOf("?")
  const path = separator === -1 ? nextPath : nextPath.slice(0, separator)
  const params = new URLSearchParams(
    separator === -1 ? "" : nextPath.slice(separator + 1),
  )
  const query: ApiQuery = {}
  for (const [key, value] of params.entries()) {
    const current = query[key]
    if (current === undefined) {
      query[key] = value
    } else if (Array.isArray(current)) {
      current.push(value)
    } else {
      query[key] = [current, value]
    }
  }
  return { path, query }
}

export function createWrapperTools({
  config,
  client,
  serverInfo,
}: WrapperToolDependencies): Record<string, ToolConfig<any>> {
  const sentryServerInfo: ToolConfig<any> = {
    name: "sentry_server_info",
    title: "Sentry Server Info",
    description:
      "Report the pinned upstream MCP revision, automatically detected Sentry version, compatibility profile, capability probes, and newer-server review advisory without exposing credentials.",
    inputSchema: {
      refresh: z
        .boolean()
        .optional()
        .describe(
          "Force a live re-probe to detect updated Sentry version and capability status.",
        ),
    },
    skills: ["inspect"],
    requiredScopes: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (args: { refresh?: boolean } = {}) => {
      const shouldRefresh = Boolean(args?.refresh)
      return json(await serverInfo.getOrRefresh(shouldRefresh))
    },
  }

  const refreshSentryCapabilities: ToolConfig<any> = {
    name: "refresh_sentry_capabilities",
    title: "Refresh Sentry Capabilities",
    description:
      "Check which Sentry APIs are available using read-only requests, then update the compatibility cache.",
    inputSchema: {},
    skills: ["inspect"],
    requiredScopes: ["org:read", "project:read", "event:read"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async () => json(await serverInfo.refresh()),
  }

  const sentryApiGet: ToolConfig<any> = {
    name: "sentry_api_get",
    title: "Sentry API GET (compatibility fallback)",
    description: `${API_FALLBACK_POLICY} Read one /api/0/ response from the configured Sentry installation. Supply path without a query or fragment; put query parameters in query.`,
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(2_048)
        .describe(
          "Relative /api/0/ path within the configured organisation/project, without query or fragment. Use only for a dedicated-tool failure or coverage gap.",
        ),
      query: querySchema.describe(
        "Query parameters separate from path. Values are strings or string arrays, for example {per_page:'5'}.",
      ),
    },
    skills: ["inspect"],
    requiredScopes: ["org:read", "project:read", "event:read"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({ path, query }: { path: string; query?: ApiQuery }) => {
      logApiFallback("sentry_api_get")
      try {
        return json({
          fallback: API_FALLBACK_NOTICE,
          ...(await client.get(path, query)),
        })
      } catch (error) {
        return errorResult(
          error,
          config,
          serverInfo.current().compatibilityProfile,
          path,
        )
      }
    },
  }

  const sentryApiPaginate: ToolConfig<any> = {
    name: "sentry_api_paginate",
    title: "Sentry API Paginate (compatibility fallback)",
    description: `${API_FALLBACK_POLICY} Use pagination only when multiple API pages are needed; use sentry_api_get for one response. Follows pagination links from the configured Sentry installation, up to the configured page and item limits.`,
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(2_048)
        .describe(
          "Relative /api/0/ collection path without query or fragment; scope and GET-only restrictions apply.",
        ),
      query: querySchema.describe(
        "Initial query parameters separate from path; subsequent pages follow Sentry cursor links.",
      ),
      maxPages: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Requested page ceiling, capped by the server configuration. Start small.",
        ),
      maxItems: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Requested item ceiling, capped by the server configuration. Start small.",
        ),
    },
    skills: ["inspect"],
    requiredScopes: ["org:read", "project:read", "event:read"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async ({
      path,
      query,
      maxPages,
      maxItems,
    }: {
      path: string
      query?: ApiQuery
      maxPages?: number
      maxItems?: number
    }) => {
      logApiFallback("sentry_api_paginate")
      const pageLimit = Math.min(
        maxPages ?? config.apiMaxPages,
        config.apiMaxPages,
      )
      const itemLimit = Math.min(
        maxItems ?? config.apiMaxItems,
        config.apiMaxItems,
      )
      try {
        let nextPath = path
        let nextQuery = (query ?? {}) as ApiQuery
        const items: unknown[] = []
        let pageCount = 0
        let hasMore = false

        while (pageCount < pageLimit && items.length < itemLimit) {
          const response = await client.get(nextPath, nextQuery)
          if (
            response.status < 200 ||
            response.status >= 300 ||
            response.truncated
          ) {
            return json({
              fallback: API_FALLBACK_NOTICE,
              error:
                "Pagination stopped because an API page failed or was incomplete; report the response status to the operator",
              response,
            })
          }
          pageCount += 1
          for (const item of responseItems(response)) {
            if (items.length >= itemLimit) break
            items.push(item)
          }
          const candidate = response.pagination?.nextPath
          hasMore = Boolean(candidate)
          if (!candidate || items.length >= itemLimit) break
          const parsed = parseNextPath(candidate)
          nextPath = parsed.path
          nextQuery = parsed.query
        }

        return json({
          fallback: API_FALLBACK_NOTICE,
          pageCount,
          itemCount: items.length,
          hasMore,
          limits: {
            maxPages: pageLimit,
            maxItems: itemLimit,
          },
          items,
        })
      } catch (error) {
        return errorResult(
          error,
          config,
          serverInfo.current().compatibilityProfile,
          path,
        )
      }
    },
  }

  return {
    ...createTeamManagementTools(config, client),
    update_issue: {
      name: "update_issue",
      title: "Update Issue",
      description:
        "Assign, unassign, resolve, reopen or set the priority of one issue in the configured organisation/project. Supply issueId and at least one change. assignedTo accepts user:ID, team:ID_OR_SLUG or null to unassign. Omitted fields remain unchanged. Writes require event:write or event:admin on the token. If a write fails or times out, read the issue before retrying; the outcome may be uncertain.",
      inputSchema: { issueId: issueIdSchema, ...issueUpdateFields },
      skills: ["triage"],
      requiredScopes: ["event:write"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async ({
        issueId,
        ...update
      }: { issueId: string } & IssueUpdate) => {
        try {
          const response = await client.updateIssue(issueId, update)
          if (
            response.status < 200 ||
            response.status >= 300 ||
            response.truncated ||
            !response.contentType
              ?.toLowerCase()
              .startsWith("application/json") ||
            !response.body ||
            typeof response.body !== "object" ||
            Array.isArray(response.body)
          ) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: json({
                    error:
                      "Issue update was not confirmed; read the issue before retrying",
                    response,
                  }),
                },
              ],
            }
          }
          return json(response)
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `${redactErrorMessage(error, config.accessToken)}; read the issue before retrying any uncertain write`,
              },
            ],
          }
        }
      },
    } satisfies ToolConfig<any>,
    sentry_server_info: sentryServerInfo,
    refresh_sentry_capabilities: refreshSentryCapabilities,
    sentry_api_get: sentryApiGet,
    sentry_api_paginate: sentryApiPaginate,
  }
}
