import { buildServer } from "../../mcp-core/src/server.ts"
import {
  setAgentProvider,
  setProviderBaseUrls,
} from "../../mcp-core/src/internal/agents/provider-factory.ts"
import { parseSkills, type Skill } from "../../mcp-core/src/skills.ts"
import upstreamTools from "../../mcp-core/src/tools/index.ts"
import type { ToolConfig } from "../../mcp-core/src/tools/types.ts"
import type { ServerContext } from "../../mcp-core/src/types.ts"

export {
  buildServer,
  parseSkills,
  setAgentProvider,
  setProviderBaseUrls,
  upstreamTools,
}
export type { ServerContext, Skill, ToolConfig }
