import dotenv from "dotenv"
import { createApp, createRuntime } from "./src/app.ts"
import { redactErrorMessage } from "./src/security/redact.ts"

dotenv.config()

const runtime = createRuntime()
const app = createApp(runtime)

void runtime.serverInfo.refresh().catch((error) => {
  console.warn(
    `[${new Date().toISOString()}] Initial Sentry capability discovery was degraded: ${redactErrorMessage(
      error,
      runtime.config.accessToken,
    )}`,
  )
})

app.listen(runtime.config.port, () => {
  console.log(
    `Streaming Tech Sentry MCP ${runtime.serverInfo.current().wrapperVersion} listening on port ${runtime.config.port}`,
  )
  console.log(`Upstream MCP ref: ${runtime.config.upstreamMcpRef}`)
  console.log(`Endpoint: http://localhost:${runtime.config.port}/mcp`)
})
