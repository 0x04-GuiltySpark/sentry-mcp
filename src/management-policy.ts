import { validateApiPath } from "./security/validate-api-path.ts"
import type { ServerContext } from "./upstream.ts"

export const MANAGEMENT_TOOLS = [
  "create_project",
  "update_project",
  "create_team",
  "add_team_to_project",
  "remove_team_from_project",
  "create_alert_rule",
  "update_alert_rule",
  "delete_alert_rule",
  "create_monitor",
  "delete_monitor_environment",
  "create_metric_monitor",
  "update_metric_monitor",
  "delete_metric_monitor",
  "create_uptime_monitor",
  "update_uptime_monitor",
  "delete_uptime_monitor",
  "create_dsn",
  "update_dsn",
] as const

export const MANAGEMENT_READ_TOOLS = [
  "find_alert_rules",
  "get_alert_rule",
  "get_alert_options",
  "find_monitors",
  "get_monitor_details",
  "find_metric_monitors",
  "get_metric_monitor_details",
  "find_uptime_monitors",
  "get_uptime_monitor_details",
  "find_dsns",
] as const

export const ORGANISATION_WRITE_TOOLS = new Set([
  "create_project",
  "create_team",
  "update_team",
  "add_member_to_team",
  "remove_member_from_team",
  "update_member_team_role",
])

export function managementWriteAllowed(
  tool: string,
  params: Record<string, unknown>,
  context: ServerContext,
  url: URL,
  method: string,
): boolean {
  const origin = `${context.sentryProtocol}://${context.sentryHost}`
  if (url.origin !== origin || url.search || url.hash) return false
  const path = validateApiPath(url.pathname, origin)
  const org = encodeURIComponent(context.constraints.organizationSlug!)
  const segment = (value: unknown) =>
    typeof value === "string" && value.length
      ? encodeURIComponent(value).replaceAll("*", "%2A")
      : "*"
  const project = segment(context.constraints.projectSlug ?? params.projectSlug)
  const projectPath = `/api/0/projects/${org}/${project}`
  const orgPath = `/api/0/organizations/${org}`
  let routes: string[] = []
  switch (tool) {
    case "create_project":
      routes = [
        `POST /api/0/teams/${org}/${segment(params.teamSlug)}/projects/`,
        `POST /api/0/projects/${org}/${segment(params.slug)}/keys/`,
        `POST /api/0/projects/${org}/${segment(params.slug)}/repo/`,
      ]
      break
    case "update_project":
      routes = [`PUT ${projectPath}/`]
      break
    case "create_team":
      routes = [`POST ${orgPath}/teams/`]
      break
    case "update_team":
      routes = [`PUT /api/0/teams/${org}/${segment(params.teamSlug)}/`]
      break
    case "add_team_to_project":
      routes = [`POST ${projectPath}/teams/${segment(params.teamSlug)}/`]
      break
    case "remove_team_from_project":
      routes = [`DELETE ${projectPath}/teams/${segment(params.teamSlug)}/`]
      break
    case "create_alert_rule":
      routes = [`POST ${orgPath}/workflows/`]
      break
    case "update_alert_rule":
      routes = [
        `PUT ${orgPath}/workflows/${segment(typeof params.ruleIdOrName === "string" && /^\d+$/.test(params.ruleIdOrName) ? params.ruleIdOrName : undefined)}/`,
      ]
      break
    case "delete_alert_rule":
      routes = [`DELETE ${orgPath}/workflows/${segment(params.ruleId)}/`]
      break
    case "create_monitor":
    case "create_metric_monitor":
      routes = [`POST ${orgPath}/projects/${project}/detectors/`]
      break
    case "update_metric_monitor":
      routes = [`PUT ${orgPath}/detectors/${segment(params.monitorId)}/`]
      break
    case "delete_metric_monitor":
      routes = [`DELETE ${orgPath}/detectors/${segment(params.monitorId)}/`]
      break
    case "delete_monitor_environment":
      routes = [
        `DELETE ${projectPath}/monitors/${segment(params.monitorSlug)}/environments/${segment(params.environment)}/`,
      ]
      break
    case "create_uptime_monitor":
      routes = [`POST ${projectPath}/uptime/`]
      break
    case "update_uptime_monitor":
      routes = [`PUT ${projectPath}/uptime/${segment(params.uptimeMonitorId)}/`]
      break
    case "delete_uptime_monitor":
      routes = [
        `DELETE ${projectPath}/uptime/${segment(params.uptimeMonitorId)}/`,
      ]
      break
    case "create_dsn":
      routes = [`POST ${projectPath}/keys/`]
      break
    case "update_dsn":
      routes = [`PUT ${projectPath}/keys/${segment(params.keyId)}/`]
      break
    case "add_member_to_team":
    case "remove_member_from_team":
    case "update_member_team_role": {
      let memberMethod = "PUT"
      if (tool === "add_member_to_team") {
        memberMethod = "POST"
      } else if (tool === "remove_member_from_team") {
        memberMethod = "DELETE"
      }
      routes = [
        `${memberMethod} ${orgPath}/members/${segment(params.memberId)}/teams/${segment(params.teamSlug)}/`,
      ]
      break
    }
  }
  if (context.constraints.projectSlug && ORGANISATION_WRITE_TOOLS.has(tool))
    return false
  const actual = `${method} ${path}`.split("/")
  return routes.some((route) => {
    const expected = route.split("/")
    return (
      expected.length === actual.length &&
      expected.every((value, index) => value === "*" || value === actual[index])
    )
  })
}
