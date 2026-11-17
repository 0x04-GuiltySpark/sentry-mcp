import type { WrapperConfig } from "../config.ts"
import type { SentryApiClient } from "../sentry-api-client.ts"
import type { DeploymentKind } from "./types.ts"

import { resolveSentryReleaseVersion } from "./github-releases.ts"

export interface VersionDetection {
  detectedVersion?: string
  detectedReleaseSha?: string
  versionSource: "bootstrap" | "github-tags" | "unknown"
  deploymentKind: DeploymentKind
}

export function parseBootstrapRelease(body: unknown): {
  version?: string
  releaseSha?: string
} {
  if (typeof body !== "string") return {}
  const shaMatch =
    body.match(/(?:release|version)[^A-Fa-f0-9]{0,80}([A-Fa-f0-9]{40})/i) ??
    body.match(/\b([A-Fa-f0-9]{40})\b/)
  const releaseSha = shaMatch?.[1]?.toLowerCase()

  const versionMatch =
    body.match(
      /(?:sentryVersion|sentry_version|version)[^0-9]{0,40}(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i,
    ) ?? body.match(/\b(\d{2,}\.\d+\.\d+)\b/)
  const version = versionMatch?.[1]
  return { version, releaseSha }
}

export async function detectVersion(
  config: WrapperConfig,
  client: SentryApiClient,
  resolveRelease: (
    sha: string,
  ) => Promise<string | undefined> = resolveSentryReleaseVersion,
): Promise<VersionDetection> {
  const deploymentKind: DeploymentKind =
    config.sentryHost === "sentry.io" ? "saas" : "self-hosted"

  let detectedVersion: string | undefined
  let detectedReleaseSha: string | undefined

  // 1. Try authenticated /api/0/ root (JSON payload)
  try {
    const apiResponse = await client.requestInternal("/api/0/", undefined, {
      authenticate: true,
      requireApiPath: false,
      timeoutMs: Math.min(config.apiTimeoutMs, 5_000),
      maxResponseBytes: Math.min(config.apiMaxResponseBytes, 131_072),
    })
    if (
      apiResponse.status >= 200 &&
      apiResponse.status < 400 &&
      apiResponse.body &&
      typeof apiResponse.body === "object"
    ) {
      const bodyObj = apiResponse.body as Record<string, unknown>
      const versionObj = bodyObj.version as Record<string, unknown> | undefined
      if (typeof versionObj?.current === "string") {
        detectedVersion = versionObj.current
      } else if (typeof bodyObj.version === "string") {
        detectedVersion = bodyObj.version
      }
      if (typeof versionObj?.build === "string") {
        if (/^[0-9a-f]{40}$/i.test(versionObj.build)) {
          detectedReleaseSha = versionObj.build
        } else if (!detectedVersion) {
          detectedVersion = versionObj.build
        }
      }
    }
  } catch {
    // Try the web page if the API request fails.
  }

  // /api/0/ returns the API version "0", not the Sentry application release.
  if (
    !detectedVersion ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(detectedVersion)
  ) {
    detectedVersion = undefined
  }

  // 2. Try web root / (HTML bootstrap fallback)
  if (!detectedVersion) {
    try {
      const response = await client.requestInternal("/", undefined, {
        authenticate: true,
        requireApiPath: false,
        timeoutMs: Math.min(config.apiTimeoutMs, 5_000),
        maxResponseBytes: Math.min(config.apiMaxResponseBytes, 262_144),
      })
      if (response.status >= 200 && response.status < 400) {
        const parsed = parseBootstrapRelease(response.body)
        detectedVersion = parsed.version
        detectedReleaseSha = parsed.releaseSha ?? detectedReleaseSha
      }
    } catch {
      // Start without a detected version if the web request fails.
    }
  }

  let versionSource: VersionDetection["versionSource"] = detectedVersion
    ? "bootstrap"
    : "unknown"
  if (!detectedVersion && detectedReleaseSha) {
    detectedVersion = await resolveRelease(detectedReleaseSha)
    if (detectedVersion) versionSource = "github-tags"
  }

  return {
    detectedVersion,
    detectedReleaseSha,
    versionSource,
    deploymentKind,
  }
}
