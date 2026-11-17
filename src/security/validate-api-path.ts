export type QueryValue = string | string[]
export type ApiQuery = Record<string, QueryValue>

const ENCODED_AMBIGUITY = /%(?:25|2e|2f|5c|00)/i
const SENSITIVE_QUERY_KEY =
  /(?:authorization|access[_-]?token|api[_-]?key|password|secret|cookie)/i

export interface ScopeCheck {
  issueId?: string
}

function decodedSegments(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
}

export function validateApiPath(path: string, origin: string): string {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\0") ||
    ENCODED_AMBIGUITY.test(path)
  ) {
    throw new Error(
      "path must be an unambiguous relative /api/0/ path without a query or fragment",
    )
  }

  let segments: string[]
  try {
    segments = decodedSegments(path)
  } catch {
    throw new Error("path contains invalid percent encoding")
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("path traversal is not allowed")
  }
  if (segments[0] !== "api" || segments[1] !== "0") {
    throw new Error("path must remain under /api/0/")
  }

  const resolved = new URL(path, origin)
  if (resolved.origin !== origin || resolved.pathname !== path) {
    throw new Error("path must remain on the configured Sentry origin")
  }
  return resolved.pathname
}

export function validateQuery(query: ApiQuery | undefined): ApiQuery {
  if (!query) return {}
  const entries = Object.entries(query)
  if (entries.length > 50) {
    throw new Error("query contains too many parameters")
  }
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || SENSITIVE_QUERY_KEY.test(key)) {
      throw new Error(`query parameter ${key || "(empty)"} is not allowed`)
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue]
    if (values.length > 25) {
      throw new Error(`query parameter ${key} has too many values`)
    }
    for (const value of values) {
      if (
        typeof value !== "string" ||
        value.length > 4_096 ||
        value.includes("\0")
      ) {
        throw new Error(`query parameter ${key} has an invalid value`)
      }
    }
  }
  return query
}

export function assertConfiguredScope(
  path: string,
  query: ApiQuery,
  organizationSlug: string,
  projectSlug?: string,
): ScopeCheck {
  const segments = decodedSegments(path)
  const root = segments[2]

  if (root === "organizations") {
    const requestedOrganization = segments[3]
    if (!requestedOrganization || requestedOrganization !== organizationSlug) {
      throw new Error(
        "path is outside the configured Sentry organization scope",
      )
    }
  } else if (root === "projects") {
    const requestedOrganization = segments[3]
    const requestedProject = segments[4]
    if (!requestedOrganization || requestedOrganization !== organizationSlug) {
      throw new Error(
        "path is outside the configured Sentry organization scope",
      )
    }
    if (projectSlug && requestedProject !== projectSlug) {
      throw new Error("path is outside the configured Sentry project scope")
    }
  } else if (root === "teams") {
    if (segments[3] !== organizationSlug)
      throw new Error(
        "path is outside the configured Sentry organization scope",
      )
    if (projectSlug)
      throw new Error("Team management requires an organisation-wide session")
  } else if (root === "issues") {
    const issueId = segments[3]
    if (!issueId || !/^[A-Za-z0-9_-]+$/.test(issueId)) {
      throw new Error(
        "issue identifier must contain only letters, digits, underscores or hyphens",
      )
    }
    return { issueId }
  } else {
    throw new Error("path root is outside the configured Sentry scope")
  }

  const organizationValues = [
    query.organization,
    query.organizationSlug,
    query.org,
  ].flatMap((value) => (value === undefined ? [] : value))
  if (organizationValues.some((value) => value !== organizationSlug)) {
    throw new Error("query is outside the configured Sentry organization scope")
  }

  if (projectSlug) {
    const projectValues = [query.project, query.projectSlug].flatMap((value) =>
      value === undefined ? [] : value,
    )
    if (projectValues.some((value) => value !== projectSlug)) {
      throw new Error("query is outside the configured Sentry project scope")
    }
  }

  return {}
}

export function appendQuery(url: URL, query: ApiQuery): void {
  for (const [key, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue]
    for (const value of values) {
      url.searchParams.append(key, value)
    }
  }
}
