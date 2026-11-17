import { parseConfig, type WrapperConfig } from "../src/config.ts"

export function testConfig(overrides: NodeJS.ProcessEnv = {}): WrapperConfig {
  return parseConfig({
    SENTRY_HOST: "sentry.example.test",
    SENTRY_ACCESS_TOKEN: "fake-token-value",
    SENTRY_ORG_SLUG: "example-org",
    ...overrides,
  })
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  })
}

export function mockFetch(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url)
    return handler(url, init)
  }) as typeof fetch
}

export const INSPECT_SCOPES = [
  "alerts:read",
  "event:read",
  "member:read",
  "org:read",
  "project:read",
  "team:read",
]
export function credentialResponse(scopes = INSPECT_SCOPES): Response {
  return jsonResponse({ version: "0", auth: { scopes }, user: null })
}
