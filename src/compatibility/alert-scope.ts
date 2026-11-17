import type { WrapperConfig } from "../config.ts"
import type { SentryApiClient } from "../sentry-api-client.ts"
import { z } from "zod"

const numericId = z.string().regex(/^\d+$/)
const workflowScope = z.object({
  id: numericId,
  detectorIds: z.array(numericId),
})
const detectorScope = z.object({
  id: numericId,
  projectId: numericId.nullable(),
})

// When project-scope is unavailable, read every detector attached to the workflow
// to identify its projects. If any detector cannot be read, refuse the operation.
export async function resolveAlertScopeCompatibility(
  client: SentryApiClient,
  config: WrapperConfig,
  url: URL,
  response: Response,
): Promise<Response> {
  const prefix = `/api/0/organizations/${encodeURIComponent(config.organizationSlug)}/workflows/`
  if (
    url.origin !== config.sentryOrigin ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix) ||
    ![404, 405].includes(response.status)
  )
    return response
  const match = url.pathname
    .slice(prefix.length)
    .match(/^(\d+)\/project-scope\/$/)
  if (!match) return response
  await response.body?.cancel()
  const ruleId = match[1]!
  const deadline = Date.now() + config.apiTimeoutMs
  const read = async (path: string) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("Alert scope discovery timed out")
    const result = await client.requestInternal(path, undefined, {
      enforceScope: true,
      timeoutMs: remaining,
    })
    if (result.status !== 200 || result.truncated)
      throw new Error(
        `Cannot establish complete alert scope (HTTP ${result.status}); no scoped write is permitted`,
      )
    return result.body
  }
  const workflowPath = `${prefix}${ruleId}/`
  const workflow = workflowScope.parse(await read(workflowPath))
  if (
    workflow.id !== ruleId ||
    workflow.detectorIds.length > config.apiMaxItems
  )
    throw new Error(
      "Cannot establish complete alert scope within the configured item limit",
    )
  const detectorIds = [...new Set(workflow.detectorIds)].sort()
  const projectIds = new Set<string>()
  let includesAllProjects = false
  for (const id of detectorIds) {
    const detector = detectorScope.parse(
      await read(
        `/api/0/organizations/${encodeURIComponent(config.organizationSlug)}/detectors/${id}/`,
      ),
    )
    if (detector.id !== id)
      throw new Error("Alert scope discovery returned a different detector")
    if (detector.projectId === null) includesAllProjects = true
    else projectIds.add(detector.projectId)
  }
  const confirmed = workflowScope.parse(await read(workflowPath))
  if (
    confirmed.id !== ruleId ||
    JSON.stringify([...new Set(confirmed.detectorIds)].sort()) !==
      JSON.stringify(detectorIds)
  )
    throw new Error(
      "Alert connections changed during scope discovery; read the alert again",
    )
  return Response.json({
    projectIds: includesAllProjects ? [] : [...projectIds].sort(),
    includesAllProjects,
  })
}
