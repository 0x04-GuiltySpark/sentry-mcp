const SECRET_KEY_PATTERN =
  /(?:authorization|access[_-]?token|api[_-]?key|password|passwd|secret|cookie)/i

export function redactText(value: string, accessToken?: string): string {
  let result = value
  if (accessToken) {
    result = result.split(accessToken).join("[REDACTED]")
  }
  result = result.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
    "Bearer [REDACTED]",
  )
  return result
}

export function redactValue(value: unknown, accessToken?: string): unknown {
  if (typeof value === "string") return redactText(value, accessToken)
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, accessToken))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key)
          ? "[REDACTED]"
          : redactValue(item, accessToken),
      ]),
    )
  }
  return value
}

export function redactErrorMessage(
  error: unknown,
  accessToken?: string,
): string {
  return redactText(
    error instanceof Error ? error.message : String(error),
    accessToken,
  )
}

export const safeErrorMessage = redactErrorMessage
