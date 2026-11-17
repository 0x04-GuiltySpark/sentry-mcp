import type { ServerContext, ToolConfig } from "./upstream.ts"

export const TOOL_ARGUMENT_NOTES: Record<string, string> = {
  update_issue:
    "Supply issueId and at least one of status, assignedTo or priority. Status is resolved/unresolved; priority is low/medium/high; assignedTo is `user:123`, `team:123` or `team:team-slug`, or null to unassign.",
  update_project:
    "Supply at least one of name, slug or platform in addition to projectSlug. A project-constrained session supplies projectSlug and cannot rename it.",
  update_team: "Supply teamSlug and at least one of name or slug.",
  add_member_to_team:
    "memberId is the organisation membership ID from find_members. Supply teamSlug too. HTTP 202 means pending membership.",
  remove_member_from_team:
    "Supply the organisation membership memberId and teamSlug.",
  update_member_team_role:
    "Supply the organisation membership memberId, teamSlug and teamRole (contributor/admin).",
  get_alert_rule:
    "Use kind=issue with ruleIdOrName set to a workflow ID, or an exact name. Use get_metric_monitor_details with monitorId for a metric monitor. kind=all searches exact names, including digit-only names.",
  create_alert_rule:
    "Supply name, actionFilters, and projectSlugs or detectorIds. Explicit detectorIds=[] creates an alert without sources. Use get_alert_options before constructing actions/conditions; actionFilters=[] is allowed.",
  update_alert_rule:
    "Supply ruleIdOrName and at least one change: name, status, frequencyMinutes, environment, owner, triggers, actionFilters, addProjectSlugs, removeProjectSlugs, addDetectorIds or removeDetectorIds. Use get_alert_rule first.",
  delete_alert_rule:
    "ruleId is the workflow ID from find_alert_rules, not a legacy project rule ID. Inspect get_alert_rule before deletion.",
  get_alert_options:
    "Supply section=actions, conditions or sources. section=conditions also requires conditionGroup=workflow_trigger or action_filter. Reuse cursors only with the same section and filters.",
  create_monitor:
    "Supply projectSlug, name and schedule. schedule is `{type:'crontab',crontab:'0 3 * * *'}` or `{type:'interval',value:1,unit:'hour'}`. Inspect the schedule schema for accepted units.",
  create_metric_monitor:
    "Supply projectSlug, name, query, config and conditionGroup using the advertised nested schemas. query includes dataset, aggregate, query, eventTypes and timeWindowSeconds. Monitor IDs are detector IDs.",
  update_metric_monitor:
    "Supply monitorId and at least one update field. Read get_metric_monitor_details first and use the advertised nested schemas for query, config and conditionGroup.",
  update_uptime_monitor:
    "Supply projectSlug, uptimeMonitorId and at least one update field. Read get_uptime_monitor_details first.",
  update_dsn:
    "Supply projectSlug, keyId and at least one settings field. Find keyId with find_dsns.",
  get_issue_details:
    "Supply issueId, issueUrl or eventId. For a specific event in a known issue, supply issueId and eventId together.",
  get_issue_activity: "Supply issueId or issueUrl.",
  get_issue_breadcrumbs:
    "Supply issueId or issueUrl; eventId optionally selects a specific event.",
  get_issue_tag_values: "Supply tagKey and either issueId or issueUrl.",
  get_issue_user_reports: "Supply issueId or issueUrl.",
  search_issue_events:
    "Supply issueId or issueUrl. Use explicit Sentry event search syntax, a short time period and a small result limit.",
  get_profile:
    "Supply transactionName and projectSlugOrId, or transactionName and profileUrl. This tool aggregates hot paths; use get_profile_details to inspect one profile.",
  get_replay_details: "Supply replayUrl or replayId.",
  get_profile_details:
    "Supply profileUrl, or projectSlugOrId plus profileId. Continuous profiles require projectSlugOrId, profilerId, start and end (ISO timestamps). Use search_profiles to find transaction profile IDs.",
  search_issues:
    "Use explicit Sentry issue search syntax. period is one of 1h,24h,7d,14d,30d,90d; limit is 1–100. Use get_issue_details for an issue's details.",
  search_profiles:
    "Use explicit Sentry search syntax, projectSlug, period and a small limit. Default fields support the documented self-hosted range.",
}

export function describeToolArguments(
  tool: ToolConfig<any>,
  context: ServerContext,
): ToolConfig<any>["description"] {
  const supplied = new Set<string>()
  if (context.constraints.organizationSlug) supplied.add("organizationSlug")
  if (context.constraints.projectSlug) {
    supplied.add("projectSlug")
    supplied.add("projectSlugOrId")
  }
  if (context.constraints.regionUrl) supplied.add("regionUrl")
  const required = Object.entries(tool.inputSchema)
    .filter(
      ([name, schema]) =>
        !supplied.has(name) &&
        !(schema as { isOptional(): boolean }).isOptional(),
    )
    .map(([name]) => name)
  const note = TOOL_ARGUMENT_NOTES[tool.name]
  const prefix = `${note ? `${note}\n` : ""}Required schema fields: ${required.join(", ") || "none"}. Use the input schema for optional filters and defaults.\n\n`
  const description =
    typeof tool.description === "string" && tool.name === "get_span_details"
      ? tool.description.replace(
          "- Use get_sentry_resource when starting from a Sentry trace or span URL.",
          "- For a trace/span URL, extract traceId and spanId. Use get_trace_details with traceId when spanId is unknown.",
        )
      : tool.description
  const directDetailTools: Record<string, string> = {
    search_issues: "get_issue_details",
    search_issue_events: "get_issue_details",
    search_traces: "get_trace_details",
  }
  if (typeof description === "string") {
    const replacement = directDetailTools[tool.name]
    const resolvedDescription = replacement
      ? description.replaceAll("get_sentry_resource", replacement)
      : description
    return prefix + resolvedDescription
  }
  return (descriptionContext) => prefix + description(descriptionContext)
}
