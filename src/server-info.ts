import {
  COMPATIBILITY_MINIMUM_VERSION,
  COMPATIBILITY_TESTED_THROUGH,
  type WrapperConfig,
  WRAPPER_VERSION,
} from "./config.ts"
import { detectVersion } from "./compatibility/detect-version.ts"
import { probeCapabilities } from "./compatibility/probe-capabilities.ts"
import {
  buildCompatibilityReview,
  selectCompatibilityProfile,
} from "./compatibility/profiles.ts"
import {
  type CapabilityMap,
  type SentryServerInfo,
  unknownCapabilities,
} from "./compatibility/types.ts"
import type { SentryApiClient } from "./sentry-api-client.ts"
import { permits, scopeAlternatives } from "./token-permissions.ts"

const CACHE_TTL_MS = 5 * 60 * 1_000

function checkStatus(
  capabilities: CapabilityMap,
): SentryServerInfo["checkStatus"] {
  const values = Object.values(capabilities).filter(
    (item) =>
      item.state !== "disabled" &&
      !(
        item.source === "configured" &&
        item.reason === "No project constraint is configured."
      ),
  )
  const supported = values.filter((item) => item.supported === true).length
  const unavailable = values.filter(
    (item) => item.state === "unavailable",
  ).length
  if (supported === 0 && unavailable > 0) return "unavailable"
  if (values.every((item) => item.supported !== null)) return "complete"
  return "degraded"
}

export class ServerInfoStore {
  private snapshot: SentryServerInfo
  private refreshPromise?: Promise<SentryServerInfo>
  private checkedAtMs = 0

  constructor(
    private readonly config: WrapperConfig,
    private readonly client: SentryApiClient,
  ) {
    const capabilities = unknownCapabilities(
      "Capability discovery has not completed.",
    )
    const deploymentKind =
      config.sentryHost === "sentry.io" ? "saas" : "self-hosted"
    this.snapshot = {
      wrapperVersion: WRAPPER_VERSION,
      enabledSkills: [],
      tokenPermissions: client.permissions.current(),
      upstreamMcpRef: config.upstreamMcpRef,
      upstreamMcpRefSource: config.upstreamMcpRefSource,
      compatibilityMinimumVersion: COMPATIBILITY_MINIMUM_VERSION,
      compatibilityEvidence: "source-and-fixtures",
      compatibilityTestedThrough: COMPATIBILITY_TESTED_THROUGH,
      versionSource: "unknown",
      deploymentKind,
      compatibilityProfile: selectCompatibilityProfile(
        config.compatibilityProfile,
        deploymentKind,
        undefined,
        capabilities,
      ),
      checkStatus: "pending",
      capabilities,
      compatibilityReview: buildCompatibilityReview(deploymentKind, undefined),
    }
  }

  current(): SentryServerInfo {
    const tokenPermissions = this.client.permissions.current()
    const enabledSkills: SentryServerInfo["enabledSkills"] =
      tokenPermissions.status === "ready" ? ["inspect"] : []
    if (permits(tokenPermissions, [scopeAlternatives("event:write")]))
      enabledSkills.push("triage")
    if (
      permits(tokenPermissions, [
        [
          "project:write",
          "project:admin",
          "team:write",
          "team:admin",
          "alerts:write",
          "alerts:admin",
          "org:write",
          "org:admin",
        ],
      ])
    )
      enabledSkills.push("project-management")
    return structuredClone({
      ...this.snapshot,
      tokenPermissions,
      enabledSkills,
      checkStatus:
        this.snapshot.checkStatus !== "pending" &&
        tokenPermissions.status !== "ready"
          ? "degraded"
          : this.snapshot.checkStatus,
    })
  }

  isStale(): boolean {
    return (
      this.snapshot.checkStatus === "pending" ||
      Date.now() - this.checkedAtMs > CACHE_TTL_MS
    )
  }

  async getOrRefresh(force = false): Promise<SentryServerInfo> {
    if (force || this.isStale()) {
      return await this.refresh()
    }
    return this.current()
  }

  refreshIfStale(): void {
    if (this.isStale()) {
      void this.refresh().catch(() => {
        // The cached degraded result remains available to server_info and health.
      })
    }
  }

  async refresh(): Promise<SentryServerInfo> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  private async performRefresh(): Promise<SentryServerInfo> {
    const [version, capabilities] = await Promise.all([
      detectVersion(this.config, this.client),
      probeCapabilities(this.config, this.client),
      this.client.permissions.refresh(),
    ])
    const checkedAt = new Date().toISOString()
    this.checkedAtMs = Date.now()
    this.snapshot = {
      wrapperVersion: WRAPPER_VERSION,
      enabledSkills: [],
      tokenPermissions: this.client.permissions.current(),
      upstreamMcpRef: this.config.upstreamMcpRef,
      upstreamMcpRefSource: this.config.upstreamMcpRefSource,
      compatibilityMinimumVersion: COMPATIBILITY_MINIMUM_VERSION,
      compatibilityEvidence: "source-and-fixtures",
      compatibilityTestedThrough: COMPATIBILITY_TESTED_THROUGH,
      detectedVersion: version.detectedVersion,
      detectedReleaseSha: version.detectedReleaseSha,
      versionSource: version.versionSource,
      deploymentKind: version.deploymentKind,
      compatibilityProfile: selectCompatibilityProfile(
        this.config.compatibilityProfile,
        version.deploymentKind,
        version.detectedVersion,
        capabilities,
      ),
      checkedAt,
      checkStatus:
        this.client.permissions.current().status === "ready"
          ? checkStatus(capabilities)
          : "degraded",
      capabilities,
      compatibilityReview: buildCompatibilityReview(
        version.deploymentKind,
        version.detectedVersion,
      ),
    }
    return this.current()
  }
}
