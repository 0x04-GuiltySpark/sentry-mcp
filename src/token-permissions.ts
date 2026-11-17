export interface TokenPermissionSnapshot {
  status: "pending" | "ready" | "unavailable"
  scopes: string[]
  checkedAt?: string
  reason?: string
}

export type ScopeRequirements = string[][]

export function scopeAlternatives(scope: string): string[] {
  const [resource, level] = scope.split(":")
  if (level === "read") return [scope, `${resource}:write`, `${resource}:admin`]
  if (level === "write") return [scope, `${resource}:admin`]
  return [scope]
}

export function permits(
  snapshot: TokenPermissionSnapshot,
  requirements: ScopeRequirements,
): boolean {
  return (
    snapshot.status === "ready" &&
    requirements.every((alternatives) =>
      alternatives.some((scope) => snapshot.scopes.includes(scope)),
    )
  )
}

export class TokenPermissions {
  private snapshot: TokenPermissionSnapshot = { status: "pending", scopes: [] }
  private inFlight?: Promise<TokenPermissionSnapshot>

  constructor(
    private readonly discover: () => Promise<{
      status: number
      body: unknown
      truncated: boolean
    }>,
  ) {}

  current(): TokenPermissionSnapshot {
    return structuredClone(this.snapshot)
  }

  async refresh(): Promise<TokenPermissionSnapshot> {
    if (!this.inFlight) {
      this.inFlight = this.performRefresh().finally(() => {
        this.inFlight = undefined
      })
    }
    return this.inFlight
  }

  async require(requirements: ScopeRequirements): Promise<void> {
    const snapshot = await this.refresh()
    if (!permits(snapshot, requirements)) {
      const missing = requirements.filter(
        (alternatives) =>
          !alternatives.some((scope) => snapshot.scopes.includes(scope)),
      )
      throw new Error(
        snapshot.status !== "ready"
          ? "Sentry token permissions could not be established; call sentry_server_info"
          : `Sentry token lacks required permissions: ${missing.map((alternatives) => alternatives.join(" or ")).join("; ")}`,
      )
    }
  }

  private async performRefresh(): Promise<TokenPermissionSnapshot> {
    const checkedAt = new Date().toISOString()
    try {
      const response = await this.discover()
      if (response.status !== 200 || response.truncated)
        throw new Error(
          `Credential discovery returned HTTP ${response.status} or an incomplete response`,
        )
      const body = response.body as { auth?: { scopes?: unknown } } | null
      const scopes = body?.auth?.scopes
      if (
        !Array.isArray(scopes) ||
        !scopes.every(
          (value) =>
            typeof value === "string" &&
            /^[a-z0-9_-]+:[a-z0-9_-]+$/.test(value),
        )
      ) {
        throw new Error(
          "Credential discovery did not return a valid auth.scopes array",
        )
      }
      this.snapshot = {
        status: "ready",
        scopes: [...new Set(scopes)].sort(),
        checkedAt,
      }
    } catch {
      // Never retain a previous grant after an unsuccessful discovery.
      this.snapshot = {
        status: "unavailable",
        scopes: [],
        checkedAt,
        reason:
          "Authenticated /api/0/ did not return usable token permissions; check credentials and Sentry connectivity.",
      }
    }
    return this.current()
  }
}
