import { closeSync, mkdirSync, openSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { home, now, readCredentials } from "../../env"
import { playbook } from "../mcp/server"

const MAIN = fileURLToPath(new URL("main.ts", import.meta.url))
const RUN_TIMEOUT_MS = 15 * 60_000

/** The gtm-brief playbook without its frontmatter, for one project. */
export const briefPrompt = (projectId: string) => playbook("gtm-brief", projectId)

/** Our environment without any Anthropic API credential, plus the subscription token from the credentials file. */
const childEnv = () => {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  const token = env.CLAUDE_CODE_OAUTH_TOKEN ?? readCredentials().CLAUDE_CODE_OAUTH_TOKEN
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
  return env
}

/**
 * One headless gtm-brief run: no built-in tools, no MCP server but `gtmkit mcp --brief-only`, only its tools
 * pre-approved. The stream-json transcript goes to $GTMKIT_HOME/logs. GTMKIT_CLAUDE_BIN replaces the claude binary.
 */
export const runBrief = async (projectId: string) => {
  const logs = join(home(), "logs")
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  const transcript = join(logs, `brief-${projectId}-${now().toISOString().replace(/[:.]/g, "-")}.jsonl`)
  const server = {
    command: process.execPath,
    args: [MAIN, "mcp", "--brief-only"],
    env: { GTMKIT_HOME: home(), ...(process.env.GTMKIT_NOW ? { GTMKIT_NOW: process.env.GTMKIT_NOW } : {}) },
  }
  const out = openSync(transcript, "w", 0o600)
  try {
    const proc = Bun.spawn(
      [
        process.env.GTMKIT_CLAUDE_BIN ?? "claude",
        "-p",
        briefPrompt(projectId),
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify({ mcpServers: { gtmkit: server } }),
        "--allowedTools",
        "mcp__gtmkit__*",
        "--output-format",
        "stream-json",
        // claude -p refuses stream-json without --verbose.
        "--verbose",
      ],
      { cwd: home(), env: childEnv(), stdin: "ignore", stdout: out, stderr: "inherit", timeout: RUN_TIMEOUT_MS },
    )
    return { transcript, exit_code: await proc.exited, signal: proc.signalCode }
  } finally {
    closeSync(out)
  }
}
