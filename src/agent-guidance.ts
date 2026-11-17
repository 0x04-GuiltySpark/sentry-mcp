import type { ServerContext, ToolConfig } from "./upstream.ts"

export const USAGE_RESOURCE_URI = "sentry-mcp://usage"
export const API_FALLBACK_POLICY =
  "Compatibility fallback only: use a dedicated tool first, and use this GET fallback only when no dedicated tool can answer. Check sentry_server_info before falling back. Whenever you use this fallback, tell the operator in your response which dedicated tool failed or what it could not answer, the relevant error/status, and which fallback was used. Ask the operator to inspect MCP sidecar and Sentry logs for a compatibility, tool-coverage or token-permission problem. Token permissions, organisation/project scope and request limits still apply."
export const API_FALLBACK_NOTICE = {
  operatorNotificationRequired: true,
  message: API_FALLBACK_POLICY,
}

export function isApiFallback(name: string): boolean {
  return name === "sentry_api_get" || name === "sentry_api_paginate"
}

export function logApiFallback(name: string): void {
  console.warn(
    JSON.stringify({
      "@timestamp": new Date().toISOString(),
      level: "WARN",
      logger: "sentry.mcp.fallback",
      tool: name,
      message:
        "Compatibility API fallback invoked; review tool coverage, compatibility and token permissions",
    }),
  )
}

export function buildAgentInstructions(names: ReadonlySet<string>): string {
  const lines = [
    "Use Sentry tools to investigate application issues and telemetry, and manage permitted Sentry resources.",
  ]
  const route = (purpose: string, candidates: string[]) => {
    const available = candidates.filter((name) => names.has(name))
    if (available.length) lines.push(`${purpose}: ${available.join(", ")}.`)
  }
  route("Grouped issues", ["search_issues"])
  route("Individual events and aggregates", [
    "search_errors",
    "search_logs",
    "search_traces",
    "search_metrics",
    "search_profiles",
    "search_replays",
  ])
  route("Inspect an identified object", [
    "get_issue_details",
    "get_trace_details",
    "get_span_details",
    "get_profile_details",
    "get_alert_rule",
  ])
  route("Discover configuration", [
    "find_projects",
    "find_teams",
    "find_members",
    "find_alert_rules",
    "find_monitors",
    "find_metric_monitors",
    "find_uptime_monitors",
  ])
  if (names.has("get_alert_options"))
    lines.push(
      "Read get_alert_options before configuring alert actions or conditions.",
    )
  if (names.has("update_issue"))
    lines.push(
      "update_issue changes issue assignment, priority or status; read the issue first.",
    )
  lines.push(
    "Tools are filtered by token permissions and configured scope. Inspect sentry_server_info for missing tools or failed calls. Use explicit Sentry query syntax, a short time period and a small result limit for searches.",
  )
  route("Manage projects, teams, membership, alerts, monitors and SDK keys", [
    "update_project",
    "create_team",
    "add_member_to_team",
    "create_alert_rule",
    "create_metric_monitor",
    "create_uptime_monitor",
    "create_dsn",
  ])
  if ([...names].some(isApiFallback)) {
    route("Compatibility fallback endpoints", [
      "sentry_api_get",
      "sentry_api_paginate",
    ])
    lines.push(API_FALLBACK_POLICY)
  }
  lines.push(
    `Read ${USAGE_RESOURCE_URI} for the available tool reference. Input schemas and tool descriptions give required and conditional arguments.`,
  )
  return lines.join("\n")
}

export function buildUsageGuide(
  names: ReadonlySet<string>,
  tools: Record<string, ToolConfig<any>>,
  context: ServerContext,
): string {
  const entries = [...names]
    .sort()
    .map(
      (name) =>
        `- ${name}: ${tools[name]!.title ?? name} (${tools[name]!.annotations.readOnlyHint ? "read" : "write"}).`,
    )
  return [
    "# Streaming Tech Sentry MCP usage",
    buildAgentInstructions(names),
    `Configured scope: organisation ${context.constraints.organizationSlug ?? "not constrained"}${context.constraints.projectSlug ? `; project ${context.constraints.projectSlug}` : ""}.`,
    "Writes require task authority and token permissions. Inspect the current object before changing it; inspect state before retrying any uncertain write. The fallback tools provide GET requests only.",
    "## Available tools",
    ...entries,
  ].join("\n\n")
}
