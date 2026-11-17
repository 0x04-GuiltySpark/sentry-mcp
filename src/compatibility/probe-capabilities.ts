import type { WrapperConfig } from "../config.ts"
import type { ApiResponse, SentryApiClient } from "../sentry-api-client.ts"
import {
  type CapabilityMap,
  type CapabilityName,
  type CapabilityResult,
  unknownCapabilities,
} from "./types.ts"

function classify(
  response: ApiResponse,
  supportedStatuses: number[] = [],
): CapabilityResult {
  const status = response.status
  if ((status >= 200 && status < 400) || supportedStatuses.includes(status)) {
    const mediaType = response.contentType
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase()
    if (
      response.body !== null &&
      mediaType !== "application/json" &&
      !mediaType?.endsWith("+json")
    ) {
      return {
        supported: null,
        state: "unknown",
        source: "probe",
        status,
        reason:
          "The route returned content that could not be confirmed as a Sentry API response.",
      }
    }
    return {
      supported: true,
      state: "supported",
      source: "probe",
      status,
    }
  }
  if (status === 404) {
    return {
      supported: false,
      state: "unsupported",
      source: "probe",
      status,
      reason: "The Sentry route returned 404.",
    }
  }
  if (status === 401 || status === 403) {
    return {
      supported: null,
      state: "inaccessible",
      source: "probe",
      status,
      reason: "The configured credentials cannot inspect this capability.",
    }
  }
  if (status >= 500) {
    return {
      supported: null,
      state: "unavailable",
      source: "probe",
      status,
      reason: "The Sentry route or an upstream dependency was unavailable.",
    }
  }
  return {
    supported: null,
    state: "unknown",
    source: "probe",
    status,
    reason: `The Sentry route returned inconclusive status ${status}.`,
  }
}

function failed(error: unknown): CapabilityResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    supported: null,
    state: /timed out|failed/i.test(message) ? "unavailable" : "unknown",
    source: "probe",
    reason: message.slice(0, 500),
  }
}

async function probe(
  client: SentryApiClient,
  config: WrapperConfig,
  path: string,
  query?: Record<string, string>,
  supportedStatuses: number[] = [],
): Promise<CapabilityResult> {
  try {
    const response = await client.requestInternal(path, query, {
      timeoutMs: Math.min(config.apiTimeoutMs, 15_000),
      maxResponseBytes: config.apiMaxResponseBytes,
    })
    return classify(response, supportedStatuses)
  } catch (error) {
    return failed(error)
  }
}

export async function probeCapabilities(
  config: WrapperConfig,
  client: SentryApiClient,
): Promise<CapabilityMap> {
  const result = unknownCapabilities("The capability has not been probed.")
  // Seer tools are disabled for this service.
  result.seer = {
    supported: null,
    state: "disabled",
    source: "configured",
    reason: "Seer is excluded by the wrapper's tool policy.",
  }
  const org = encodeURIComponent(config.organizationSlug)

  const probes: Array<Promise<[CapabilityName, CapabilityResult]>> = [
    probe(client, config, "/api/0/", undefined, [400, 405]).then((value) => [
      "apiRoot",
      value,
    ]),
    probe(
      client,
      config,
      `/api/0/organizations/${org}/`,
      undefined,
      [400, 405],
    ).then((value) => ["organizationAccess", value]),
    probe(
      client,
      config,
      `/api/0/organizations/${org}/events/validate/`,
      { dataset: "errors" },
      [400, 405, 422],
    ).then((value) => ["eventsValidate", value]),
    probe(
      client,
      config,
      `/api/0/organizations/${org}/events/`,
      { per_page: "1" },
      [400],
    ).then((value) => ["organizationEvents", value]),
    probe(
      client,
      config,
      `/api/0/organizations/${org}/trace-items/attributes/`,
      {
        itemType: "error",
        attributeType: "string",
        per_page: "1",
      },
      [400, 405, 422],
    ).then((value) => ["traceItemAttributes", value]),
    probe(
      client,
      config,
      `/api/0/organizations/${org}/replays/`,
      { per_page: "1" },
      [400, 405],
    ).then((value) => ["replays", value]),
  ]

  // Validate actual dataset queries: events/validate does not validate profiles.
  for (const [name, dataset, field] of [
    ["profileSearch", "profiles", "profile.id"],
    ["logSearch", "logs", "timestamp"],
  ] as const) {
    probes.push(
      probe(client, config, `/api/0/organizations/${org}/events/`, {
        dataset,
        field,
        statsPeriod: "1h",
        per_page: "1",
        ...(config.projectSlug
          ? { query: `project:${config.projectSlug}` }
          : {}),
      }).then((value) => [name, value]),
    )
  }

  if (config.projectSlug) {
    probes.push(
      probe(
        client,
        config,
        `/api/0/projects/${org}/${encodeURIComponent(config.projectSlug)}/`,
        undefined,
        [400, 405],
      ).then((value) => ["projectAccess", value]),
    )
  } else {
    result.projectAccess = {
      supported: null,
      state: "unknown",
      source: "configured",
      reason: "No project constraint is configured.",
    }
  }

  for (const [name, value] of await Promise.all(probes)) {
    result[name] = value
  }

  try {
    const issues = await client.requestInternal(
      `/api/0/organizations/${org}/issues/`,
      { per_page: "1" },
      {
        timeoutMs: Math.min(config.apiTimeoutMs, 15_000),
        maxResponseBytes: config.apiMaxResponseBytes,
      },
    )
    const issueResult = classify(issues, [400])
    const firstIssue =
      Array.isArray(issues.body) &&
      issues.body[0] &&
      typeof issues.body[0] === "object"
        ? (issues.body[0] as Record<string, unknown>)
        : undefined
    const issueId =
      typeof firstIssue?.id === "string" ? firstIssue.id : undefined
    if (issueResult.supported === true && issueId) {
      const encodedIssue = encodeURIComponent(issueId)
      result.issueEvents = await probe(
        client,
        config,
        `/api/0/issues/${encodedIssue}/events/latest/`,
        undefined,
        [400, 405],
      )
    } else if (issueResult.supported === true) {
      const noIssue: CapabilityResult = {
        supported: null,
        state: "unknown",
        source: "probe",
        status: issues.status,
        reason: "No issue was available to check the issue detail API.",
      }
      result.issueEvents = noIssue
    } else {
      result.issueEvents = issueResult
    }
  } catch (error) {
    result.issueEvents = failed(error)
  }

  return result
}
