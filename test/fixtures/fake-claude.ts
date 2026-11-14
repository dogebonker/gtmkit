// Stands in for the claude CLI (GTMKIT_CLAUDE_BIN). Records its argv and the Anthropic-related environment in
// FAKE_CLAUDE_LOG, then walks the gtm-brief steps against the --mcp-config server, as the model would.
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { appendFileSync } from "node:fs"

const args = process.argv.slice(2)
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("ANTHROPIC_") || k === "CLAUDE_CODE_OAUTH_TOKEN"))
appendFileSync(process.env.FAKE_CLAUDE_LOG!, `${JSON.stringify({ args, env, cwd: process.cwd() })}\n`)

const flag = (name: string) => args[args.indexOf(name) + 1]!
const projectId = /The project id is `([^`]+)`/.exec(flag("-p"))![1]!
const server = JSON.parse(flag("--mcp-config")).mcpServers.gtmkit as { command: string; args: string[]; env: Record<string, string> }
const client = new Client({ name: "fake-claude", version: "0" })
await client.connect(new StdioClientTransport({ ...server, env: { PATH: process.env.PATH ?? "", ...server.env } }))
const call = async (name: string, a: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: a })) as { content: { text: string }[]; isError?: boolean }
  if (r.isError) throw new Error(r.content[0]!.text)
  return JSON.parse(r.content[0]!.text)
}

const { tools } = await client.listTools()
console.log(JSON.stringify({ type: "system", subtype: "init", tools: tools.map((t) => `mcp__gtmkit__${t.name}`) }))
await call("project_get", { project_id: projectId })
const digest = await call("digest", { project_id: projectId })
await call("actions_list", { project_id: projectId })
await call("brief_save", { project_id: projectId, period: digest.period, markdown: `# Brief ${digest.period}\n\nNothing changed.` })
await client.close()
console.log(JSON.stringify({ type: "result", subtype: "success" }))
