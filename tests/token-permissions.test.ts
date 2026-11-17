import { describe, expect, it } from "vitest"
import {
  permits,
  scopeAlternatives,
  TokenPermissions,
} from "../src/token-permissions.ts"

describe("Sentry token permission discovery", () => {
  it.each([null, { id: "123", email: "private@example.test" }])(
    "accepts integration and personal credentials without retaining identity: %j",
    async (user) => {
      const permissions = new TokenPermissions(async () => ({
        status: 200,
        truncated: false,
        body: {
          auth: { scopes: ["event:read", "event:read", "org:read"] },
          user,
        },
      }))
      expect(await permissions.refresh()).toMatchObject({
        status: "ready",
        scopes: ["event:read", "org:read"],
      })
      expect(JSON.stringify(permissions.current())).not.toContain(
        "private@example.test",
      )
    },
  )

  it.each([
    {
      status: 401,
      body: { auth: { scopes: ["event:write"] } },
      truncated: false,
    },
    { status: 500, body: {}, truncated: false },
    { status: 200, body: { auth: null }, truncated: false },
    {
      status: 200,
      body: { auth: { scopes: "event:write" } },
      truncated: false,
    },
    {
      status: 200,
      body: { auth: { scopes: ["not a scope"] } },
      truncated: false,
    },
    {
      status: 200,
      body: { auth: { scopes: ["event:write"] } },
      truncated: true,
    },
  ])("fails closed for unusable credentials: %j", async (response) => {
    const permissions = new TokenPermissions(async () => response)
    expect(await permissions.refresh()).toMatchObject({
      status: "unavailable",
      scopes: [],
    })
    await expect(
      permissions.require([scopeAlternatives("event:write")]),
    ).rejects.toThrow("could not be established")
  })

  it("distinguishes read/write permissions and recognises an accepted admin alternative", () => {
    const snapshot = {
      status: "ready" as const,
      scopes: ["event:admin", "project:read"],
    }
    expect(
      permits(snapshot, [
        scopeAlternatives("event:write"),
        scopeAlternatives("project:read"),
      ]),
    ).toBe(true)
    expect(permits(snapshot, [scopeAlternatives("alerts:write")])).toBe(false)
    expect(
      permits({ status: "ready", scopes: ["event:read"] }, [
        scopeAlternatives("event:write"),
      ]),
    ).toBe(false)
    expect(permits({ status: "unavailable", scopes: [] }, [])).toBe(false)
  })

  it("deduplicates concurrent discovery but clears old grants on a later failure", async () => {
    let calls = 0
    let fails = false
    const permissions = new TokenPermissions(async () => {
      calls += 1
      if (fails) throw new Error("private failure details")
      return {
        status: 200,
        truncated: false,
        body: { auth: { scopes: ["event:write"] } },
      }
    })
    await Promise.all([permissions.refresh(), permissions.refresh()])
    expect(calls).toBe(1)
    fails = true
    await permissions.refresh()
    expect(permissions.current()).toMatchObject({
      status: "unavailable",
      scopes: [],
    })
    expect(JSON.stringify(permissions.current())).not.toContain(
      "private failure details",
    )
  })
})
