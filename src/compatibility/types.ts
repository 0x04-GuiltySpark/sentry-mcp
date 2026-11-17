import type { TokenPermissionSnapshot } from "../token-permissions.ts"

export const CAPABILITY_NAMES = [
  "apiRoot",
  "organizationAccess",
  "projectAccess",
  "eventsValidate",
  "organizationEvents",
  "profileSearch",
  "logSearch",
  "issueEvents",
  "traceItemAttributes",
  "replays",
  "seer",
] as const

export type CapabilityName = (typeof CAPABILITY_NAMES)[number]

export type CapabilityState =
  | "disabled"
  | "supported"
  | "unsupported"
  | "inaccessible"
  | "unavailable"
  | "unknown"

export interface CapabilityResult {
  supported: boolean | null
  state: CapabilityState
  source: "probe" | "version-map" | "configured" | "unknown"
  status?: number
  reason?: string
}

export type CapabilityMap = Record<CapabilityName, CapabilityResult>

export type DeploymentKind = "self-hosted" | "saas" | "unknown"

export type SelectedCompatibilityProfile =
  | "self-hosted-26.5"
  | "self-hosted-current"
  | "unknown-conservative"
  | "sentry-saas"

export interface CompatibilityReview {
  required: boolean
  minimumVersion: string
  evidence: "source-and-fixtures"
  testedThrough: string
  detectedVersion?: string
  reason?: string
  recommendedAction?: string
}

export interface SentryServerInfo {
  tokenPermissions: TokenPermissionSnapshot
  enabledSkills: ("inspect" | "triage" | "project-management")[]
  wrapperVersion: string
  upstreamMcpRef: string
  upstreamMcpRefSource: "package-default" | "instance-override"
  compatibilityMinimumVersion: string
  compatibilityEvidence: "source-and-fixtures"
  compatibilityTestedThrough: string
  detectedVersion?: string
  detectedReleaseSha?: string
  versionSource: "bootstrap" | "github-tags" | "unknown"
  deploymentKind: DeploymentKind
  compatibilityProfile: SelectedCompatibilityProfile
  checkedAt?: string
  checkStatus: "pending" | "complete" | "degraded" | "unavailable"
  capabilities: CapabilityMap
  compatibilityReview: CompatibilityReview
}

export function unknownCapabilities(reason: string): CapabilityMap {
  return Object.fromEntries(
    CAPABILITY_NAMES.map((name) => [
      name,
      {
        supported: null,
        state: "unknown",
        source: "unknown",
        reason,
      } satisfies CapabilityResult,
    ]),
  ) as CapabilityMap
}
