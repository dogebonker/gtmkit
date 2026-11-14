import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { describe, expect, test } from "vite-plus/test"
import { createActions } from "../src/actions"
import { openDb } from "../src/db"
import { createServer } from "../src/edge/mcp/server"
import { upsertProject } from "../src/projects"
import { createSignals, type Providers } from "../src/signals"
import { fakeDataForSEO, fakeSearchConsole, fakeWeb } from "./fake-provider"

const W42 = "2026-10-12T08:00:00.000Z" // 2026-W42: round 0
const W45 = "2026-11-02T08:00:00.000Z" // 2026-W45: round 1
const W46 = "2026-11-09T08:00:00.000Z" // 4 weeks after W42, 1 week after W45

const profile = {
  domain: "example.com",
  brand_names: ["Example"],
  location: "United States",
  language: "English",
  competitors: ["rival-one.com"],
  keywords: ["crm for freelancers", "simple crm"].map((value) => ({ value, cluster: "crm", intent: "commercial" })),
}

const setup = async () => {
  process.env.GTMKIT_NOW = W42
  const db = openDb(":memory:")
  const world = { round: 0 }
  const providers: Providers = {
    dataforseo: fakeDataForSEO({ world }).dataforseo,
    gsc: fakeSearchConsole(world).gsc,
    web: fakeWeb(world).web,
  }
  const signals = createSignals(db, providers)
  signals.setCap("global", 150)
  signals.setCap("default", 30)
  const project = upsertProject(db, profile)
  const other = upsertProject(db, { ...profile, domain: "other.com" })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createServer(db, providers).connect(serverSide)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(clientSide)
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    const text = r.content[0]!.text
    return { isError: r.isError ?? false, text, body: JSON.parse(text) }
  }
  return { db, world, signals, project, other, call }
}

const serpTarget = { kind: "serp_top30", subject: "crm for freelancers", key: "position:example.com" }

describe("actions_propose", () => {
  test("AC6: an unknown evidence id, or one from another project, is rejected; a stored one of the project is accepted", async () => {
    const s = await setup()
    await s.signals.runDue()
    const own = s.signals.query(s.project.id, "serp_top30")[0]!.id
    const foreign = (await s.signals.collect(s.other.id, "keyword_gap", { subject: "rival-one.com" }, false)) as { snapshot: { id: number } }
    const propose = (evidence: number[], target: Record<string, string> = serpTarget) =>
      s.call("actions_propose", { project_id: s.project.id, title: "Rewrite the landing page", rationale: "Lost a position.", evidence, target })

    const unknown = await propose([own, 99_999])
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain("evidence 99999 is not a stored snapshot")

    const otherProject = await propose([foreign.snapshot.id])
    expect(otherProject.isError).toBe(true)
    expect(otherProject.text).toContain(`evidence ${foreign.snapshot.id} is not a stored snapshot of project ${s.project.id}`)

    expect((await propose([])).isError).toBe(true)
    expect((await propose([own], { ...serpTarget, key: " " })).text).toContain("name the target metric")

    const ok = await propose([own])
    expect(ok.isError).toBe(false)
    expect(ok.body).toMatchObject({ status: "proposed", evidence: [own], target: serpTarget })
    expect(s.db.query("SELECT count(*) AS n FROM actions").get()).toEqual({ n: 1 })
  })
})

describe("actions_update", () => {
  test("status moves proposed -> accepted -> done and nothing else; done records done_at and the baseline", async () => {
    const s = await setup()
    await s.signals.runDue()
    const evidence = [s.signals.query(s.project.id, "serp_top30")[0]!.id]
    const { body: a } = await s.call("actions_propose", { project_id: s.project.id, title: "t", rationale: "r", evidence, target: serpTarget })
    const update = (status: string, project_id = s.project.id) => s.call("actions_update", { project_id, action_id: a.id, status })

    expect((await update("done")).text).toContain("refused: proposed -> done")
    expect((await update("accepted", s.other.id)).isError).toBe(true)
    expect((await update("accepted")).body.status).toBe("accepted")
    const done = await update("done")
    expect(done.body).toMatchObject({ status: "done", done_at: W42, baseline: 2 })
    expect((await update("dropped")).text).toContain("refused: done -> dropped")
  })
})

describe("actions_list", () => {
  test("AC7: done 4 weeks ago lists baseline, current and delta; done 1 week ago lists none; two done actions on one target are flagged", async () => {
    const s = await setup()
    await s.signals.runDue() // W42: example.com is at 2 for "crm for freelancers", 50 clicks
    const evidence = [s.signals.query(s.project.id, "serp_top30")[0]!.id]
    const finish = async (target: Record<string, string>) => {
      const { body } = await s.call("actions_propose", { project_id: s.project.id, title: "t", rationale: "r", evidence, target })
      await s.call("actions_update", { project_id: s.project.id, action_id: body.id, status: "accepted" })
      await s.call("actions_update", { project_id: s.project.id, action_id: body.id, status: "done" })
      return body.id as number
    }
    const fourWeeks = await finish(serpTarget)
    const sameTarget = await finish(serpTarget)

    s.world.round = 1 // newcomer.com enters at 1: example.com drops to 3; clicks 50 -> 80
    process.env.GTMKIT_NOW = W45
    await s.signals.runDue()
    const clicksTarget = { kind: "gsc_performance", subject: "crm for freelancers", key: "clicks" }
    const oneWeek = await finish(clicksTarget)
    const { body: open } = await s.call("actions_propose", { project_id: s.project.id, title: "t", rationale: "r", evidence, target: clicksTarget })

    process.env.GTMKIT_NOW = W46
    const { body } = await s.call("actions_list", { project_id: s.project.id })
    const byId = new Map((body.actions as { id: number }[]).map((a) => [a.id, a]))

    expect(byId.get(fourWeeks)).toMatchObject({
      status: "done",
      done_at: W42,
      shared_target: true,
      delta: { note: expect.stringContaining("a delta, not proof"), baseline: 2, current: 3, delta: 1 },
    })
    expect(byId.get(sameTarget)).toMatchObject({ shared_target: true, delta: { baseline: 2, current: 3, delta: 1 } })
    expect(byId.get(oneWeek)).toMatchObject({ status: "done", done_at: W45, baseline: 80, delta: null, shared_target: false })
    expect(byId.get(open.id)).not.toHaveProperty("delta")
  })
})

describe("briefs", () => {
  test("the latest brief is the one of the newest period, not the newest row", async () => {
    const s = await setup()
    const actions = createActions(s.db, s.signals)
    actions.saveBrief(s.project.id, "2026-W42", "# W42")
    process.env.GTMKIT_NOW = W45
    actions.saveBrief(s.project.id, "2026-W41", "# W41, written late")
    expect(actions.latestBrief(s.project.id)).toMatchObject({ period: "2026-W42", markdown: "# W42" })
  })
})
