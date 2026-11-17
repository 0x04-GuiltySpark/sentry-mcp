import { z } from "zod"
import type { WrapperConfig } from "../config.ts"
import type { SentryApiClient } from "../sentry-api-client.ts"
import { redactErrorMessage } from "../security/redact.ts"
import { scopeAlternatives } from "../token-permissions.ts"
import type { ToolConfig } from "../upstream.ts"

const teamSlug = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
const memberId = z
  .string()
  .regex(/^\d+$/)
  .describe(
    "Organisation membership ID from find_members; this is not the nested user.id",
  )
export const MEMBER_WRITE_REQUIREMENTS = [
  ["team:write", "team:admin", "org:write", "org:admin"],
  scopeAlternatives("org:read"),
  scopeAlternatives("member:read"),
]

export function createTeamManagementTools(
  config: WrapperConfig,
  client: SentryApiClient,
): Record<string, ToolConfig<any>> {
  const org = encodeURIComponent(config.organizationSlug)
  const annotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  }
  const tools: Record<string, ToolConfig<any>> = {}
  for (const name of ["find_members", "find_team_members"] as const) {
    tools[name] = {
      name,
      title: name === "find_members" ? "Find Members" : "Find Team Members",
      description:
        "Find members for issue assignment or team membership changes. Use the top-level membership id for team membership changes and nested user.id for issue assignment. Responses may contain personal account details.",
      inputSchema: {
        ...(name === "find_team_members" ? { teamSlug } : {}),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      skills: ["inspect"],
      requiredScopes: ["member:read"],
      annotations: {
        ...annotations,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      handler: async (args: {
        teamSlug?: string
        query?: string
        limit: number
      }) =>
        JSON.stringify(
          await client.get(
            name === "find_members"
              ? `/api/0/organizations/${org}/members/`
              : `/api/0/teams/${org}/${encodeURIComponent(args.teamSlug!)}/members/`,
            {
              per_page: String(Math.min(args.limit, config.apiMaxItems)),
              ...(args.query ? { query: args.query } : {}),
            },
          ),
        ),
    }
  }
  for (const name of [
    "add_member_to_team",
    "remove_member_from_team",
    "update_member_team_role",
    "update_team",
  ] as const) {
    const isTeam = name === "update_team"
    const method =
      name === "add_member_to_team"
        ? "POST"
        : name === "remove_member_from_team"
          ? "DELETE"
          : "PUT"
    tools[name] = {
      name,
      title: name.replaceAll("_", " "),
      description: isTeam
        ? "Update a team's name or slug. Organisation-wide sessions only. Team renaming affects all its projects. Omitted fields remain unchanged."
        : "Change an existing organisation member's team membership or team-level role. Organisation-wide sessions only; this affects all projects accessible through the team. Sentry enforces actor roles, Open Membership and identity-provider restrictions. HTTP 202 means a pending request, not completed membership. Inspect state before retrying any failed or uncertain write.",
      inputSchema: {
        teamSlug,
        ...(isTeam
          ? {
              name: z.string().trim().min(1).max(128).optional(),
              slug: teamSlug.optional(),
            }
          : {
              memberId,
              ...(name === "update_member_team_role"
                ? { teamRole: z.enum(["contributor", "admin"]) }
                : {}),
            }),
      },
      skills: ["project-management"],
      requiredScopes: isTeam
        ? ["team:write"]
        : ["org:read", "member:read", "team:write"],
      annotations,
      handler: async (args: {
        teamSlug: string
        memberId?: string
        teamRole?: "contributor" | "admin"
        name?: string
        slug?: string
      }) => {
        try {
          if (config.projectSlug)
            throw new Error(
              "Team and membership writes require an organisation-wide session",
            )
          if (isTeam && args.name === undefined && args.slug === undefined)
            throw new Error("Provide name or slug")
          const path = isTeam
            ? `/api/0/teams/${org}/${encodeURIComponent(args.teamSlug!)}/`
            : `/api/0/organizations/${org}/members/${encodeURIComponent(args.memberId!)}/teams/${encodeURIComponent(args.teamSlug!)}/`
          const body = isTeam
            ? {
                ...(args.name !== undefined ? { name: args.name } : {}),
                ...(args.slug !== undefined ? { slug: args.slug } : {}),
              }
            : name === "update_member_team_role"
              ? { teamRole: args.teamRole }
              : undefined
          const response = await client.managementRequest(
            method,
            path,
            body,
            isTeam
              ? [scopeAlternatives("team:write")]
              : MEMBER_WRITE_REQUIREMENTS,
          )
          if (
            response.status < 200 ||
            response.status >= 300 ||
            response.truncated
          )
            throw new Error(
              `Management request was not confirmed (HTTP ${response.status}); inspect state before retrying`,
            )
          let outcome: string | undefined
          if (name === "add_member_to_team") {
            if (response.status === 202) {
              outcome = "pending"
            } else if (response.status === 204) {
              outcome = "already_member"
            } else {
              outcome = "added"
            }
          }
          return JSON.stringify({
            ...response,
            ...(outcome ? { outcome } : {}),
          })
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: redactErrorMessage(error, config.accessToken),
              },
            ],
          }
        }
      },
    }
  }
  return tools
}
