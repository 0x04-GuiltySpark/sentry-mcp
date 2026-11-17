import { describe, expect, it } from "vitest"
import {
  buildCompatibilityReview,
  compareVersions,
  selectCompatibilityProfile,
} from "../src/compatibility/profiles.ts"
import { unknownCapabilities } from "../src/compatibility/types.ts"

describe("compatibility profiles", () => {
  it("compares Sentry releases by numeric semantic version", () => {
    expect(compareVersions("26.5.1", "26.5.1")).toBe(0)
    expect(compareVersions("26.6.0", "26.5.1")).toBe(1)
    expect(compareVersions("25.12.9", "26.5.1")).toBe(-1)
  })

  it("selects the 26.5 baseline without events/validate", () => {
    const capabilities = unknownCapabilities("test")
    capabilities.eventsValidate = {
      supported: false,
      state: "unsupported",
      source: "probe",
      status: 404,
    }
    expect(
      selectCompatibilityProfile(
        "auto",
        "self-hosted",
        undefined,
        capabilities,
      ),
    ).toBe("self-hosted-26.5")
  })

  it("uses a conservative profile when version and capabilities are unknown", () => {
    expect(
      selectCompatibilityProfile(
        "auto",
        "self-hosted",
        undefined,
        unknownCapabilities("test"),
      ),
    ).toBe("unknown-conservative")
  })

  it("does not let an explicit current profile override an absent route", () => {
    const capabilities = unknownCapabilities("test")
    capabilities.eventsValidate = {
      supported: false,
      state: "unsupported",
      source: "probe",
      status: 404,
    }
    expect(
      selectCompatibilityProfile(
        "self-hosted-current",
        "self-hosted",
        "26.6.0",
        capabilities,
      ),
    ).toBe("self-hosted-26.5")
  })

  it("requires review for unknown or out-of-range self-hosted versions", () => {
    expect(buildCompatibilityReview("self-hosted", "26.6.0").required).toBe(
      true,
    )
    expect(buildCompatibilityReview("self-hosted", "26.7.2").required).toBe(
      false,
    )
    expect(buildCompatibilityReview("self-hosted", "26.10.1").required).toBe(
      false,
    )
    expect(buildCompatibilityReview("self-hosted", undefined).required).toBe(
      true,
    )
    expect(buildCompatibilityReview("saas", "99.0.0").required).toBe(false)
  })
})
