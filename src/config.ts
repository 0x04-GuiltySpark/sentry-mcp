import { readFileSync } from "node:fs"

const manifest: { version: string; sentryMcpRef: string } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)

export const DEFAULT_UPSTREAM_MCP_REF = manifest.sentryMcpRef
export const WRAPPER_VERSION = manifest.version
export const COMPATIBILITY_MINIMUM_VERSION = "26.7.2"
export const COMPATIBILITY_TESTED_THROUGH = "26.10.1"
export const MAX_API_TIMEOUT_MS = 60_000

export const COMPATIBILITY_PROFILES = [
  "auto",
  "self-hosted-26.5",
  "self-hosted-current",
  "unknown-conservative",
  "sentry-saas",
] as const

export type CompatibilityProfileInput = (typeof COMPATIBILITY_PROFILES)[number]

export interface WrapperConfig {
  port: number
  sentryHost: string
  sentryProtocol: "http" | "https"
  sentryOrigin: string
  accessToken: string
  organizationSlug: string
  projectSlug?: string
  compatibilityProfile: CompatibilityProfileInput
  upstreamMcpRef: string
  upstreamMcpRefSource: "package-default" | "instance-override"
  apiTimeoutMs: number
  apiMaxResponseBytes: number
  apiMaxPages: number
  apiMaxItems: number
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value || undefined
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = optional(env, name)
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function parseBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = optional(env, name)
  if (!raw) return fallback
  if (raw === "true") return true
  if (raw === "false") return false
  throw new Error(`${name} must be true or false`)
}

function parseHost(rawHost: string, protocol: "http" | "https"): string {
  if (
    rawHost.includes("://") ||
    rawHost.includes("/") ||
    rawHost.includes("\\") ||
    rawHost.includes("@") ||
    /\s/.test(rawHost)
  ) {
    throw new Error(
      "SENTRY_HOST must be a hostname with an optional port and no URL scheme or path",
    )
  }
  let parsed: URL
  try {
    parsed = new URL(`${protocol}://${rawHost}`)
  } catch {
    throw new Error("SENTRY_HOST is not a valid hostname")
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error("SENTRY_HOST is not a valid hostname")
  }
  return parsed.host
}

function parseSlug(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(raw)) {
    throw new Error(`${name} contains unsupported characters`)
  }
  return raw
}

function parseCompatibilityProfile(
  raw: string | undefined,
): CompatibilityProfileInput {
  const value = raw ?? "auto"
  if (!COMPATIBILITY_PROFILES.includes(value as CompatibilityProfileInput)) {
    throw new Error(
      `SENTRY_COMPAT_PROFILE must be one of ${COMPATIBILITY_PROFILES.join(", ")}`,
    )
  }
  return value as CompatibilityProfileInput
}

function parseUpstreamRef(raw: string | undefined): string {
  const value = raw ?? DEFAULT_UPSTREAM_MCP_REF
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(
      "SENTRY_MCP_REF must be a full lowercase 40-character Git commit SHA",
    )
  }
  return value
}

export function parseConfig(env: NodeJS.ProcessEnv): WrapperConfig {
  const sentryProtocol = parseBoolean(env, "SENTRY_INSECURE_HTTP", false)
    ? "http"
    : "https"
  const sentryHost = parseHost(required(env, "SENTRY_HOST"), sentryProtocol)
  const organizationSlug = parseSlug(
    "SENTRY_ORG_SLUG",
    required(env, "SENTRY_ORG_SLUG"),
  )
  const upstreamMcpRef = parseUpstreamRef(optional(env, "SENTRY_MCP_REF"))

  return {
    port: parseInteger(env, "PORT", 7013, 1, 65535),
    sentryHost,
    sentryProtocol,
    sentryOrigin: `${sentryProtocol}://${sentryHost}`,
    accessToken: required(env, "SENTRY_ACCESS_TOKEN"),
    organizationSlug: organizationSlug!,
    projectSlug: parseSlug(
      "SENTRY_PROJECT_SLUG",
      optional(env, "SENTRY_PROJECT_SLUG"),
    ),
    compatibilityProfile: parseCompatibilityProfile(
      optional(env, "SENTRY_COMPAT_PROFILE"),
    ),
    upstreamMcpRef,
    upstreamMcpRefSource:
      upstreamMcpRef === DEFAULT_UPSTREAM_MCP_REF
        ? "package-default"
        : "instance-override",
    apiTimeoutMs: parseInteger(
      env,
      "SENTRY_API_TIMEOUT_MS",
      MAX_API_TIMEOUT_MS,
      1_000,
      MAX_API_TIMEOUT_MS,
    ),
    apiMaxResponseBytes: parseInteger(
      env,
      "SENTRY_API_MAX_RESPONSE_BYTES",
      1_048_576,
      1_024,
      10_485_760,
    ),
    apiMaxPages: parseInteger(env, "SENTRY_API_MAX_PAGES", 5, 1, 20),
    apiMaxItems: parseInteger(env, "SENTRY_API_MAX_ITEMS", 250, 1, 1_000),
  }
}
