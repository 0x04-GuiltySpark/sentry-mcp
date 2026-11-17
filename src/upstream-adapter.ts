import type { SentryServerInfo } from "./compatibility/types.ts"
import {
  MANAGEMENT_TOOLS,
  MANAGEMENT_READ_TOOLS,
  ORGANISATION_WRITE_TOOLS,
  managementWriteAllowed,
} from "./management-policy.ts"
import { withManagementOperation } from "./upstream-deadline.ts"
import { MEMBER_WRITE_REQUIREMENTS } from "./tools/team-management.ts"
import { redactErrorMessage } from "./security/redact.ts"
import { describeToolArguments } from "./tool-arguments.ts"
import {
  API_FALLBACK_NOTICE,
  buildAgentInstructions,
  buildUsageGuide,
  isApiFallback,
  logApiFallback,
  USAGE_RESOURCE_URI,
} from "./agent-guidance.ts"
import {
  permits,
  scopeAlternatives,
  type TokenPermissions,
  type ScopeRequirements,
} from "./token-permissions.ts"
import {
  buildServer,
  type ServerContext,
  type ToolConfig,
  upstreamTools,
} from "./upstream.ts"

// Upstream handlers can call tools from the full registry. Restrict that registry
// as well as the advertised tool list to prevent access to unauthorised tools.
const INSPECT_TOOLS = [
  "whoami",
  "find_organizations",
  "find_teams",
  "find_projects",
  "find_releases",
  "get_release_details",
  "get_issue_details",
  "get_event_stacktrace",
  "get_issue_activity",
  "get_issue_breadcrumbs",
  "get_issue_user_reports",
  "get_issue_tag_values",
  "get_trace_details",
  "get_span_details",
  "get_replay_details",
  "get_event_attachment",
  "search_attributes",
  "search_errors",
  "search_logs",
  "search_traces",
  "search_metrics",
  "search_profiles",
  "search_replays",
  "search_events",
  "search_issues",
  "search_issue_events",
  "find_dropped_events",
  "get_profile",
  "get_profile_details",
  "search_docs",
  "get_doc",
] as const

// Transaction-profile columns shared by Sentry 26.7.2, 26.8.0 and 26.10.1.
// Continuous-profile identifiers belong to the separate profile-details API.
export const PROFILE_DEFAULT_FIELDS = [
  "project",
  "profile.id",
  "timestamp",
  "transaction",
  "profile.duration",
  "release",
  "environment",
  "trace",
]

export function createMergedToolRegistry(
  wrapperTools: Record<string, ToolConfig<any>>,
  serverInfo: SentryServerInfo,
): Record<string, ToolConfig<any>> {
  const merged: Record<string, ToolConfig<any>> = { ...wrapperTools }
  for (const name of INSPECT_TOOLS) {
    if (
      (name === "get_replay_details" || name === "search_replays") &&
      serverInfo.capabilities.replays.supported !== true
    )
      continue
    const tool = upstreamTools[name]
    if (
      !tool ||
      !tool.annotations.readOnlyHint ||
      !tool.skills.includes("inspect")
    ) {
      throw new Error(
        `Upstream tool ${name} no longer meets the inspect-only contract`,
      )
    }
    merged[name] = tool
  }
  for (const name of ["search_profiles", "search_events"] as const) {
    const tool = merged[name]!
    merged[name] = {
      ...tool,
      ...(name === "search_profiles"
        ? {
            description:
              "Search transaction profiles using Sentry search syntax. Defaults use columns supported by self-hosted Sentry 26.7.2–26.10.1. Use get_profile_details with profileId for results, or profilerId and start/end for known continuous profiles.",
          }
        : {}),
      handler: (params, context) => {
        const needsDefaultFields =
          (name === "search_profiles" || params.dataset === "profiles") &&
          (!Array.isArray(params.fields) || params.fields.length === 0)
        const mergedParams = needsDefaultFields
          ? { ...params, fields: [...PROFILE_DEFAULT_FIELDS] }
          : params
        return tool.handler(mergedParams, context)
      },
    }
  }
  for (const name of [...MANAGEMENT_TOOLS, ...MANAGEMENT_READ_TOOLS]) {
    const tool = upstreamTools[name]
    if (
      !tool ||
      ((MANAGEMENT_TOOLS as readonly string[]).includes(name)
        ? !tool.skills.includes("project-management") ||
          tool.annotations.readOnlyHint
        : !tool.annotations.readOnlyHint)
    )
      throw new Error(`Upstream management contract changed: ${name}`)
    merged[name] = tool
  }
  return merged
}

export function createUpstreamServer(options: {
  context: ServerContext
  wrapperTools: Record<string, ToolConfig<any>>
  serverInfo: SentryServerInfo
  experimentalMode?: boolean
  operationTimeoutMs?: number
  permissions: TokenPermissions
}) {
  const registry = createMergedToolRegistry(
    options.wrapperTools,
    options.serverInfo,
  )
  const filtered: Record<string, ToolConfig<any>> = {}
  for (const [name, tool] of Object.entries(registry)) {
    if (
      options.context.constraints.projectSlug &&
      (ORGANISATION_WRITE_TOOLS.has(name) || name === "find_team_members")
    )
      continue
    if (
      name === "sentry_server_info" ||
      name === "refresh_sentry_capabilities"
    ) {
      filtered[name] = {
        ...tool,
        description: describeToolArguments(tool, options.context),
      }
      continue
    }
    let requirements: ScopeRequirements =
      tool.requiredScopes.map(scopeAlternatives)
    if (
      [
        "add_member_to_team",
        "remove_member_from_team",
        "update_member_team_role",
      ].includes(name)
    )
      requirements = MEMBER_WRITE_REQUIREMENTS
    if (name === "find_releases" || name === "get_release_details") {
      requirements = [
        [...scopeAlternatives("project:read"), "project:releases", "org:ci"],
      ]
    }
    if (name === "sentry_api_get" || name === "sentry_api_paginate") {
      requirements = [
        [
          ...new Set(
            [
              "org:read",
              "project:read",
              "team:read",
              "member:read",
              "event:read",
              "alerts:read",
            ].flatMap(scopeAlternatives),
          ),
        ],
      ]
    }
    if (!permits(options.permissions.current(), requirements)) continue
    filtered[name] = {
      ...tool,
      description: describeToolArguments(tool, options.context),
      handler: async (params, context) => {
        const startedAt = Date.now()
        try {
          await options.permissions.require(requirements)
        } catch (error) {
          if (isApiFallback(name)) logApiFallback(name)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: isApiFallback(name)
                  ? JSON.stringify({
                      fallback: API_FALLBACK_NOTICE,
                      error: redactErrorMessage(error, context.accessToken),
                    })
                  : redactErrorMessage(error, context.accessToken),
              },
            ],
          }
        }
        if (tool.annotations.readOnlyHint || name === "update_issue")
          return tool.handler(params, context)
        const origin = `${context.sentryProtocol}://${context.sentryHost}`
        return withManagementOperation(
          origin,
          async (url, method) => {
            if (!managementWriteAllowed(name, params, context, url, method))
              throw new Error(
                "Write is outside this management tool's configured resource scope",
              )
            await options.permissions.require(requirements)
          },
          () => tool.handler(params, context),
          Math.max(
            0,
            (options.operationTimeoutMs ?? 60_000) - (Date.now() - startedAt),
          ),
        )
      },
    }
  }
  let registeredNames: ReadonlySet<string> = new Set()
  const server = buildServer({
    context: options.context,
    experimentalMode: options.experimentalMode,
    tools: filtered,
    buildInstructions: (names) => {
      registeredNames = names
      return buildAgentInstructions(names)
    },
  })
  server.registerResource(
    "sentry-usage",
    USAGE_RESOURCE_URI,
    {
      title: "Sentry tool usage",
      mimeType: "text/markdown",
      description:
        "Available tools, routing, permissions and compatibility fallback reporting for this session.",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: buildUsageGuide(registeredNames, filtered, options.context),
        },
      ],
    }),
  )
  return server
}
