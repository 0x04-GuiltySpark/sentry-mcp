# Tools and permissions

The sidecar exposes tools according to the token’s scopes.

| Access level       | Available actions                                                    | Token permissions                                                                                |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Inspection         | Read issues, telemetry and configuration                             | Recommended: `alerts:read`, `event:read`, `member:read`, `org:read`, `project:read`, `team:read` |
| Issue management   | Inspection plus assignment, priority and resolution                  | Add `event:write`                                                                                |
| Project management | Configure projects, teams, membership, alerts, monitors and SDK keys | Add the relevant write scopes listed below                                                       |

Corresponding write/admin scopes satisfy read requirements; admin satisfies write. Release reads also accept `project:releases` or `org:ci`. Membership writes accept either `team:write` or `org:write`, plus organisation/member read access.

Tables describe an organisation-scoped session. The sidecar supplies `organizationSlug`; a project constraint supplies project arguments and hides organisation-wide team/membership writes and project creation. The client’s tool schema provides optional filters, defaults and nested configuration shapes.

## Inspection

| Tool                          | Purpose                                                                    | Required token scopes                                       | Required inputs                                                      |
| ----------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `find_alert_rules`            | Find Sentry alert rules                                                    | `org:read`, `project:read`                                  | None                                                                 |
| `find_dropped_events`         | Inspect dropped-event counts and reasons                                   | `event:read`                                                | None                                                                 |
| `find_dsns`                   | List public SDK keys                                                       | `project:read`                                              | projectSlug                                                          |
| `find_members`                | List organisation members                                                  | `member:read`                                               | None                                                                 |
| `find_metric_monitors`        | List metric monitors                                                       | `org:read`, `project:read`                                  | None                                                                 |
| `find_monitors`               | List cron monitors                                                         | `org:read`                                                  | None                                                                 |
| `find_projects`               | List or search projects in a Sentry organisation                           | `project:read`                                              | None                                                                 |
| `find_releases`               | List deployed releases                                                     | `project:read` or release scope above                       | None                                                                 |
| `find_team_members`           | List team members                                                          | `member:read`                                               | teamSlug                                                             |
| `find_teams`                  | List or search teams in a Sentry organisation                              | `team:read`                                                 | None                                                                 |
| `find_uptime_monitors`        | Find Sentry uptime monitors                                                | `org:read`, `project:read`                                  | None                                                                 |
| `get_alert_options`           | Discover alert actions, conditions and sources                             | `org:read`, `project:read`                                  | section (+ conditionGroup for conditions)                            |
| `get_alert_rule`              | Get details for one Sentry alert rule by ID or exact name                  | `org:read`, `project:read`                                  | ruleIdOrName                                                         |
| `get_doc`                     | Fetch the full markdown content of a Sentry documentation page             | —                                                           | path                                                                 |
| `get_event_attachment`        | Download attachments from a Sentry event                                   | `event:read`                                                | projectSlug, eventId                                                 |
| `get_event_stacktrace`        | Read an event thread’s stack trace                                         | `event:read`                                                | issueId                                                              |
| `get_issue_activity`          | Get the activity feed and comments for a Sentry issue                      | `event:read`                                                | issueId or issueUrl                                                  |
| `get_issue_breadcrumbs`       | Get the breadcrumb trail from a Sentry issue event                         | `event:read`                                                | issueId or issueUrl                                                  |
| `get_issue_details`           | Get detailed information about a specific Sentry issue by ID               | `event:read`                                                | issueId or issueUrl or eventId                                       |
| `get_issue_tag_values`        | Get tag value distribution for a specific Sentry issue                     | `event:read`                                                | tagKey, plus issueId or issueUrl                                     |
| `get_issue_user_reports`      | Read submitted crash reports                                               | `event:read`                                                | issueId or issueUrl                                                  |
| `get_metric_monitor_details`  | Inspect metric queries and thresholds                                      | `org:read`, `project:read`                                  | monitorId                                                            |
| `get_monitor_details`         | Get details and recent check-ins for a Sentry cron monitor (scheduled job) | `project:read`                                              | monitorSlug                                                          |
| `get_profile`                 | Analyse CPU hot paths for a transaction                                    | `event:read`                                                | transactionName, plus projectSlugOrId or profileUrl                  |
| `get_profile_details`         | Inspect one profile’s samples and frames                                   | `event:read`                                                | profileUrl or projectSlugOrId + profileId; see continuous mode below |
| `get_release_details`         | Get details for a Sentry release                                           | `project:read` or release scope above                       | releaseVersion                                                       |
| `get_replay_details`          | Read a replay summary and timeline                                         | `org:read`, `project:read`, `event:read`                    | replayUrl or replayId                                                |
| `get_span_details`            | Get detailed information about a specific span within a Sentry trace       | `event:read`                                                | traceId, spanId                                                      |
| `get_trace_details`           | Get detailed information about a specific Sentry trace by ID               | `event:read`                                                | traceId                                                              |
| `get_uptime_monitor_details`  | Read uptime settings and recent checks                                     | `project:read`                                              | projectSlug, uptimeMonitorId                                         |
| `refresh_sentry_capabilities` | Repeat read-only capability checks                                         | —                                                           | None                                                                 |
| `search_docs`                 | Search Sentry Docs                                                         | —                                                           | query                                                                |
| `search_errors`               | Search error events and aggregates                                         | `event:read`                                                | None                                                                 |
| `search_events`               | Search a selected event dataset                                            | `event:read`                                                | None                                                                 |
| `search_issue_events`         | Search and filter events within a specific issue                           | `event:read`                                                | issueId or issueUrl                                                  |
| `search_issues`               | Find grouped issues                                                        | `event:read`                                                | None                                                                 |
| `search_logs`                 | Search log entries and aggregates                                          | `event:read`                                                | None                                                                 |
| `search_metrics`              | Search metric values and aggregates                                        | `event:read`                                                | None                                                                 |
| `search_profiles`             | Search transaction profiles                                                | `event:read`                                                | None                                                                 |
| `search_replays`              | Find session replays                                                       | `event:read`                                                | None                                                                 |
| `search_traces`               | Search spans and traces                                                    | `event:read`                                                | None                                                                 |
| `sentry_api_get`              | Fallback: read one API response                                            | Any recommended read scope; endpoint permissions also apply | path                                                                 |
| `sentry_api_paginate`         | Fallback: read API pages                                                   | Any recommended read scope; endpoint permissions also apply | path                                                                 |
| `sentry_server_info`          | Read server, permission and capability status                              | —                                                           | None                                                                 |
| `whoami`                      | Identify the authenticated user in Sentry                                  | —                                                           | None                                                                 |

## Issue management

| Tool           | Purpose                                        | Required token scopes | Required inputs               |
| -------------- | ---------------------------------------------- | --------------------- | ----------------------------- |
| `update_issue` | Assign, prioritise, resolve or reopen an issue | `event:write`         | issueId + at least one change |

## Project management

| Tool                         | Purpose                                              | Required token scopes                                       | Required inputs                                       |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| `add_member_to_team`         | Add a member to a team                               | `org:read`, `member:read`, plus `team:write` or `org:write` | teamSlug, memberId                                    |
| `add_team_to_project`        | Grant a team access to an existing Sentry project    | `project:write`, `team:read`, `org:read`                    | projectSlug, teamSlug                                 |
| `create_alert_rule`          | Create a notification workflow                       | `org:read`, `project:read`, `alerts:write`                  | name, actionFilters, plus projectSlugs or detectorIds |
| `create_dsn`                 | Create an additional DSN for an EXISTING project     | `project:write`                                             | projectSlug, name                                     |
| `create_metric_monitor`      | Create metric threshold monitoring                   | `org:read`, `project:read`, `alerts:write`                  | projectSlug, name, query, config, conditionGroup      |
| `create_monitor`             | Create a Sentry cron monitor                         | `org:read`, `project:read`, `alerts:write`                  | projectSlug, name, schedule                           |
| `create_project`             | Create a project and default SDK key                 | `project:write`, `team:read`, `org:read`                    | teamSlug, name                                        |
| `create_team`                | Create a new team in Sentry                          | `team:write`                                                | name                                                  |
| `create_uptime_monitor`      | Create a Sentry HTTP uptime monitor                  | `project:write`                                             | projectSlug, name, url, intervalSeconds               |
| `delete_alert_rule`          | Delete a notification workflow                       | `org:read`, `project:read`, `alerts:write`                  | ruleId                                                |
| `delete_metric_monitor`      | Delete a metric monitor                              | `org:read`, `project:read`, `alerts:write`                  | monitorId                                             |
| `delete_monitor_environment` | Delete one environment from a Sentry cron monitor    | `project:write`                                             | projectSlug, monitorSlug, environment                 |
| `delete_uptime_monitor`      | Delete a Sentry HTTP uptime monitor                  | `project:write`                                             | projectSlug, uptimeMonitorId                          |
| `remove_member_from_team`    | Remove a member from a team                          | `org:read`, `member:read`, plus `team:write` or `org:write` | teamSlug, memberId                                    |
| `remove_team_from_project`   | Revoke a team's access to an existing Sentry project | `project:write`, `team:read`, `org:read`                    | projectSlug, teamSlug                                 |
| `update_alert_rule`          | Change notification settings and sources             | `org:read`, `project:read`, `alerts:write`                  | ruleIdOrName + at least one change                    |
| `update_dsn`                 | Change SDK-key settings                              | `project:write`                                             | projectSlug, keyId + at least one change              |
| `update_member_team_role`    | Change a member’s team role                          | `org:read`, `member:read`, plus `team:write` or `org:write` | teamSlug, memberId, teamRole                          |
| `update_metric_monitor`      | Change metric monitoring configuration               | `org:read`, `project:read`, `alerts:write`                  | monitorId + at least one change                       |
| `update_project`             | Change project name, slug or platform                | `project:write`                                             | projectSlug + at least one change                     |
| `update_team`                | Rename a team or change its slug                     | `team:write`                                                | teamSlug + at least one change                        |
| `update_uptime_monitor`      | Update a Sentry HTTP uptime monitor                  | `project:write`                                             | projectSlug, uptimeMonitorId + at least one change    |

## Input notes

- **API fallbacks:** use `sentry_api_get` or `sentry_api_paginate` only when a dedicated tool cannot answer, after checking `sentry_server_info`. Report the dedicated tool’s failure or coverage gap and the fallback used to the operator; ask them to inspect MCP sidecar and Sentry logs for compatibility or token-permission problems. Fallbacks retain token permissions and resource restrictions.
- **Issues:** `status` is `resolved`/`unresolved`; `priority` is `low`/`medium`/`high`. Assignment uses `user:123`, `team:123`, `team:team-slug` or `null`. Membership changes use the top-level organisation `memberId`, with `teamRole` set to `contributor`/`admin`; HTTP 202 means pending.
- **Updates:** project changes use `name`, `slug` or `platform`; team changes use `name` or `slug`. Read the existing alert, monitor or SDK key before changing its settings.
- **Alerts:** use `kind=issue` and a workflow ID for `get_alert_rule`. `kind=all` searches exact names. `get_alert_options` supplies action/condition schemas. Creating an alert with `detectorIds=[]` and `actionFilters=[]` leaves it without notification sources/actions.
- **Monitors:** metric `monitorId` is a detector ID; uptime uses `uptimeMonitorId`; cron uses `monitorSlug`. Cron schedules accept `{type:"crontab",crontab:"0 3 * * *"}` or `{type:"interval",value:1,unit:"hour"}`. Metric creation requires the advertised `query`, `config` and `conditionGroup` objects.
- **Profiles:** continuous mode uses `projectSlugOrId`, `profilerId`, `start` and `end` (ISO timestamps). Transaction profiles use `profileId`.
- **Searches:** use explicit Sentry syntax, small `limit` values and a short `period`. Issue periods are `1h`, `24h`, `7d`, `14d`, `30d`, `90d`; dataset searches also accept relative windows such as `30m`.

Writes remain within the configured organisation/project. Shared-alert scope must be verified before project-scoped writes; a constrained project cannot be renamed. Writes reject redirects and automatic replay. After an uncertain result, inspect state before retrying. Generic API tools provide GET requests.
