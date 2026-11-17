import {
  COMPATIBILITY_MINIMUM_VERSION,
  COMPATIBILITY_TESTED_THROUGH,
  type CompatibilityProfileInput,
} from "../config.ts"
import type {
  CapabilityMap,
  CompatibilityReview,
  DeploymentKind,
  SelectedCompatibilityProfile,
} from "./types.ts"

function numericVersion(version: string): [number, number, number] | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(left: string, right: string): number {
  const a = numericVersion(left)
  const b = numericVersion(right)
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! < b[index]!) return -1
    if (a[index]! > b[index]!) return 1
  }
  return 0
}

export function selectCompatibilityProfile(
  requested: CompatibilityProfileInput,
  deploymentKind: DeploymentKind,
  effectiveVersion: string | undefined,
  capabilities: CapabilityMap,
): SelectedCompatibilityProfile {
  if (requested !== "auto") {
    if (
      capabilities.eventsValidate.supported === false &&
      (requested === "self-hosted-current" || requested === "sentry-saas")
    ) {
      return "self-hosted-26.5"
    }
    return requested
  }
  if (deploymentKind === "saas") return "sentry-saas"
  if (
    effectiveVersion &&
    compareVersions(effectiveVersion, COMPATIBILITY_MINIMUM_VERSION) < 0
  ) {
    return "self-hosted-26.5"
  }
  if (capabilities.eventsValidate.supported === false) {
    return "self-hosted-26.5"
  }
  if (
    deploymentKind === "self-hosted" &&
    capabilities.eventsValidate.supported === true
  ) {
    return "self-hosted-current"
  }
  return "unknown-conservative"
}

export function buildCompatibilityReview(
  deploymentKind: DeploymentKind,
  effectiveVersion: string | undefined,
): CompatibilityReview {
  const unknown = !effectiveVersion || !numericVersion(effectiveVersion)
  const outsideRange =
    !unknown &&
    (compareVersions(effectiveVersion!, COMPATIBILITY_MINIMUM_VERSION) < 0 ||
      compareVersions(effectiveVersion!, COMPATIBILITY_TESTED_THROUGH) > 0)
  const required = deploymentKind !== "saas" && (unknown || outsideRange)
  return {
    required,
    minimumVersion: COMPATIBILITY_MINIMUM_VERSION,
    testedThrough: COMPATIBILITY_TESTED_THROUGH,
    evidence: "source-and-fixtures",
    detectedVersion: effectiveVersion,
    ...(required
      ? {
          reason: unknown
            ? "The Sentry application version could not be established."
            : "The Sentry server is outside the source-reviewed and fixture-tested compatibility range.",
          recommendedAction:
            "Confirm the deployed Sentry release and run issue, log and profile queries for the configured project. Review getsentry/toolkit before changing the pinned commit.",
        }
      : {}),
  }
}
