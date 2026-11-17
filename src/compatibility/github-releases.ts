const CACHE_TTL_MS = 60 * 60 * 1_000
const RETRY_DELAY_MS = 15 * 60 * 1_000
const MAX_PAGES = 5
const MAX_PAGE_BYTES = 262_144

// The tags API supplies the release commit, including for annotated tags.
// Release records' target_commitish can instead be a branch name.
export class SentryReleaseCache {
  private versions = new Map<string, string>()
  private nextRefreshAt = 0
  private pending?: Promise<void>

  constructor(
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(releaseSha: string): Promise<string | undefined> {
    if (!/^[a-f0-9]{40}$/i.test(releaseSha)) return undefined
    if (!this.pending && this.now() >= this.nextRefreshAt) {
      this.pending = this.refresh().finally(() => {
        this.pending = undefined
      })
    }
    await this.pending
    return this.versions.get(releaseSha.toLowerCase())
  }

  private async refresh(): Promise<void> {
    this.nextRefreshAt = this.now() + RETRY_DELAY_MS
    const signal = AbortSignal.timeout(5_000)
    const versions = new Map<string, string>()
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await this.fetcher(
          `https://api.github.com/repos/getsentry/sentry/tags?per_page=100&page=${page}`,
          {
            headers: {
              accept: "application/vnd.github+json",
              "user-agent": "streaming-tech-sentry-mcp",
            },
            redirect: "error",
            credentials: "omit",
            signal,
          },
        )
        if (!response.ok || !response.body) {
          await response.body?.cancel()
          throw new Error("GitHub release metadata unavailable")
        }
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_PAGE_BYTES) {
              await reader.cancel()
              throw new Error("GitHub release metadata exceeded the size limit")
            }
            chunks.push(value)
          }
        } finally {
          reader.releaseLock()
        }
        const rows: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        if (!Array.isArray(rows) || rows.length > 100) {
          throw new Error("Unexpected GitHub release metadata")
        }
        for (const row of rows) {
          if (
            typeof row?.name !== "string" ||
            typeof row?.commit?.sha !== "string"
          ) {
            throw new Error("Unexpected GitHub tag record")
          }
          const version = row.name.replace(/^v/, "")
          if (
            /^\d+\.\d+\.\d+$/.test(version) &&
            /^[a-f0-9]{40}$/i.test(row.commit.sha)
          ) {
            versions.set(row.commit.sha.toLowerCase(), version)
          }
        }
        if (rows.length < 100) break
      }
      this.versions = versions
      this.nextRefreshAt = this.now() + CACHE_TTL_MS
    } catch {
      // Retain previously resolved releases during outages or rate limiting.
      // Detection is advisory and must never prevent Sentry access or startup.
    }
  }
}

const releaseCache = new SentryReleaseCache()
export const resolveSentryReleaseVersion = (sha: string) =>
  releaseCache.resolve(sha)
