import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { randomUUID } from "node:crypto";
import { bootWorkspace, writeArtifact } from "./bridge.js";
import { currentTraceRef, flushTelemetry, inSpan, logEvent, telemetry } from "./telemetry.js";
import { evidenceForAgent } from "./signoz.js";

// Workspace scripts run from apps/runner; always load Faultline's root config.
dotenv.config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

type Scenario = "healthy" | "incident";
type AgentStatus = "queued" | "working" | "complete" | "risk" | "failed";
type ExecutionEvent = { at:string; type:string; detail:string; tone:"info"|"good"|"warn"|"bad" };
type Agent = {
  id: string;
  name: string;
  status: AgentStatus;
  duration: number;
  tokens: number;
  retries: number;
  decision: string;
  artifact: string;
  error?: string;
  systemPrompt: string;
  taskPrompt: string;
  model: string;
  output: string;
  artifactContent: string;
  traceId: string;
  spanId: string;
  events: ExecutionEvent[];
};
type RunStatus = "running" | "healthy" | "attention" | "failed";
type MobilePlan = {
  appName:string;
  greeting:string;
  balanceLabel:string;
  balance:string;
  balanceChange:string;
  actionLabel:string;
  categories:Array<{name:string;amount:string;color:string}>;
  activity:Array<{title:string;meta:string;amount:string}>;
  insightTitle:string;
  insightCopy:string;
};
type Run = {
  id: string;
  brief: string;
  scenario: Scenario;
  status: RunStatus;
  startedAt: string;
  traceId: string;
  totalTokens: number;
  budget: number;
  agents: Agent[];
  previewUrl: string;
  mobilePlan?: MobilePlan;
  error?: string;
};
const app = express();
const runs: Run[] = [];
app.use(cors());
app.use(express.json());
const signoz = () => process.env.SIGNOZ_UI_URL || "http://localhost:8080";
const systemPrompt = "Return one concise mobile app implementation decision.";
const model = () => process.env.OPENAI_MODEL || "openai/gpt-4o-mini";
const record = (agent:Agent, type:string, detail:string, tone:ExecutionEvent["tone"]="info") => agent.events.push({ at:new Date().toISOString(), type, detail, tone });

async function invokeModel(prompt: string) {
  const base = (process.env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  const key = process.env.OPENAI_API_KEY || "";
  if (!base || !key)
    throw new Error("Missing OPENAI_BASE_URL or OPENAI_API_KEY");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model(),
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 220,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data: any = await res.json();
  return {
    tokens: data.usage?.total_tokens || 120,
    decision:
      data.choices?.[0]?.message?.content ||
      "Generated mobile screen contract",
  };
}

const fallbackPlan = (brief:string):MobilePlan => ({
  appName: brief.toLowerCase().includes('budget') ? 'Gather' : 'Daymark',
  greeting: 'Good morning, Alex',
  balanceLabel: brief.toLowerCase().includes('budget') ? 'Available this week' : 'Today at a glance',
  balance: brief.toLowerCase().includes('budget') ? '$842.60' : '4 priorities',
  balanceChange: brief.toLowerCase().includes('budget') ? '+$126 from last week' : '2 complete since yesterday',
  actionLabel: brief.toLowerCase().includes('budget') ? 'Add expense' : 'Add item',
  categories:[{name:'Essentials',amount:'$412',color:'#5d71e9'},{name:'Shared plans',amount:'$168',color:'#e39162'},{name:'Free time',amount:'$94',color:'#6fb9a8'}],
  activity:[{title:'Weekly plan updated',meta:'Just now',amount:'+ $126'},{title:'Groceries',meta:'Today, 10:32 AM',amount:'- $58.40'},{title:'Rent contribution',meta:'Yesterday',amount:'- $320.00'}],
  insightTitle:'You are pacing well', insightCopy:'Your weekly plan is on track. Essentials account for the largest share of activity.',
});

async function invokeMobilePlan(brief:string):Promise<MobilePlan> {
  const base = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, ''); const key = process.env.OPENAI_API_KEY || '';
  if (!base || !key) return fallbackPlan(brief);
  const response = await fetch(`${base}/chat/completions`, { method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${key}`}, body:JSON.stringify({ model:model(), max_tokens:500, messages:[{role:'system',content:'Return only valid JSON. Create a concise mobile app preview spec with appName, greeting, balanceLabel, balance, balanceChange, actionLabel, categories (3 objects: name, amount, color hex), activity (3 objects: title, meta, amount), insightTitle, insightCopy.'},{role:'user',content:`App brief: ${brief}`}] }) });
  if (!response.ok) return fallbackPlan(brief);
  const data:any = await response.json(); const raw = String(data.choices?.[0]?.message?.content || '').replace(/^```json\s*|\s*```$/g, '');
  try { return { ...fallbackPlan(brief), ...JSON.parse(raw) }; } catch { return fallbackPlan(brief); }
}

app.get("/health", (_q, res) =>
  res.json({
    ok: true,
    service: "faultline-runner",
    signoz: signoz(),
    bridge: process.env.FAULTLINE_BRIDGE_URL || "http://localhost:4320",
  }),
);
app.get("/api/runs", (_q, res) =>
  res.json(
    [...runs].sort(
      (a, b) =>
        Number(b.status === "attention" || b.status === "failed") -
          Number(a.status === "attention" || a.status === "failed") ||
        Number(b.status === "running") - Number(a.status === "running") ||
        b.startedAt.localeCompare(a.startedAt),
    ),
  ),
);

const pipeline = [
  ["planner", "Plan", "app-plan.json"],
  ["architecture", "Architecture", "routes.ts"],
  ["design", "Design system", "tokens.ts"],
  ["primary", "Primary screen", "HomeScreen.tsx"],
] as const;

async function executeRun(run: Run) {
  let total = 0;
  try {
    const root = await inSpan(
      "agent.run",
      {
        "faultline.run_id": run.id,
        "faultline.scenario": run.scenario,
        "faultline.budget_tokens": run.budget,
      },
      async () => {
        for (const [index, [agent, name, artifact]] of pipeline.entries())
          await inSpan(
            `agent.${agent}`,
            { "faultline.run_id": run.id, "faultline.agent_id": agent },
            async () => {
              const current = run.agents[index];
              const taskPrompt = `${run.brief}\nAgent: ${name}`;
              const trace = currentTraceRef();
              current.traceId = trace.traceId;
              current.spanId = trace.spanId;
              current.taskPrompt = taskPrompt;
              current.status = "working";
              current.decision = "Preparing isolated agent workspace…";
              record(current, "Workspace started", "Booting isolated agent workspace.");
              logEvent("faultline.workspace.started", { "faultline.run_id":run.id, "faultline.agent_id":agent, "faultline.scenario":run.scenario });
              logEvent(systemPrompt, { "faultline.event":"model.request", "faultline.run_id":run.id, "faultline.agent_id":agent, "faultline.prompt_type":"system" });
              await bootWorkspace(run.id, agent, run.brief);
              let retries = 0;
              let error: string | undefined;
              if (run.scenario === "incident" && index === 1) {
                retries = 1;
                error =
                  "Injected timeout: upstream model gateway exceeded 250ms";
                current.retries = retries;
                current.error = error;
                current.decision =
                  "Timeout recorded. Retrying the model request…";
                record(current, "Timeout recorded", error, "warn");
                logEvent("faultline.retry", { "faultline.run_id":run.id, "faultline.agent_id":agent, "faultline.reason":"timeout", "faultline.attempt":2 });
                telemetry.retries.add(1, { agent });
                await inSpan(
                  "agent.retry",
                  {
                    "faultline.injected": true,
                    "faultline.reason": "timeout",
                    "faultline.agent_id": agent,
                  },
                  async () => {
                    await new Promise((r) => setTimeout(r, 80));
                    return null;
                  },
                );
              }
              const llm = await inSpan(
                "llm.chat.completions",
                {
                  "gen_ai.system": "openai-compatible",
                  "gen_ai.request.model":
                    process.env.OPENAI_MODEL || "openai/gpt-4o-mini",
                  "faultline.agent_id": agent,
                },
                () => {
                  record(current, "Model request", `Sending full prompt to ${model()}.`);
                  logEvent(taskPrompt, { "faultline.event":"model.request", "faultline.run_id":run.id, "faultline.agent_id":agent, "faultline.prompt_type":"user" });
                  return invokeModel(taskPrompt);
                },
              );
              total += llm.value.tokens;
              run.totalTokens = total;
              telemetry.tokens.add(llm.value.tokens, { agent });
              telemetry.duration.record(220 + index * 90, { agent });
              await writeArtifact(run.id, agent, artifact, llm.value.decision);
              record(current, "Model response", "Model completed its implementation decision.", "good");
              record(current, "Artifact written", `Published ${artifact}.`, "good");
              logEvent(llm.value.decision, { "faultline.event":"model.response", "faultline.run_id":run.id, "faultline.agent_id":agent, "faultline.output_type":"decision" });
              logEvent(`Artifact written: ${artifact}`, { "faultline.event":"artifact.write", "faultline.run_id":run.id, "faultline.agent_id":agent, "faultline.artifact":artifact });
              Object.assign(current, {
                status: error ? "risk" : "complete",
                duration: 220 + index * 90,
                tokens: llm.value.tokens,
                retries,
                decision: llm.value.decision,
                artifact,
                error,
                output: llm.value.decision,
                artifactContent: llm.value.decision,
              });
              if (agent === 'primary') {
                run.mobilePlan = await invokeMobilePlan(run.brief);
                record(current, 'Preview screen model generated', 'Generated interactive mobile screen content.', 'good');
                logEvent(JSON.stringify(run.mobilePlan), { 'faultline.event':'preview.model', 'faultline.run_id':run.id, 'faultline.agent_id':agent });
              }
              return null;
            },
          );
        logEvent("faultline.preview.published", { "faultline.event":"preview.publish", "faultline.run_id":run.id });
        return null;
      },
    );
    const breached = total > run.budget;
    if (breached) telemetry.breaches.add(1, { scenario: run.scenario });
    telemetry.runs.add(1, { outcome: breached ? "attention" : "healthy" });
    await flushTelemetry();
    run.traceId = root.traceId;
    run.agents.forEach(agent => { agent.traceId = root.traceId; if(agent.id === 'primary') record(agent, 'Preview published', 'Expo preview is ready for operator review.', 'good'); });
    run.status =
      breached || run.scenario === "incident" ? "attention" : "healthy";
  } catch (error) {
    const current = run.agents.find((agent) => agent.status === "working");
    if (current) {
      current.status = "failed";
      current.error = error instanceof Error ? error.message : String(error);
      current.decision = "Agent failed before completing its artifact.";
      record(current, "Agent failed", current.error, "bad");
      logEvent(current.error, { "faultline.event":"agent.failure", "faultline.run_id":run.id, "faultline.agent_id":current.id });
    }
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    telemetry.runs.add(1, { outcome: "failed" });
    await flushTelemetry();
  }
}

app.post("/api/runs", (req, res) => {
  const brief = String(
    req.body.brief || "A personal finance app for shared household budgets",
  );
  const scenario: Scenario =
    req.body.scenario === "incident" ? "incident" : "healthy";
  const id = randomUUID();
  const budget = scenario === "incident" ? 80 : 1200;
  const run: Run = {
    id,
    brief,
    scenario,
    status: "running",
    startedAt: new Date().toISOString(),
    traceId: "",
    totalTokens: 0,
    budget,
    agents: pipeline.map(([id, name, artifact]) => ({
      id,
      name,
      status: "queued",
      duration: 0,
      tokens: 0,
      retries: 0,
      decision: "Waiting for the preceding agent…",
      artifact,
      systemPrompt,
      taskPrompt: "",
      model: model(),
      output: "",
      artifactContent: "",
      traceId: "",
      spanId: "",
      events: [],
    })),
    previewUrl: `http://localhost:8081/?run=${id}`,
    mobilePlan: fallbackPlan(brief),
  };
  runs.unshift(run);
  res.status(201).json(run);
  void executeRun(run);
});
app.get("/api/runs/:id", (req, res) => {
  const run = runs.find((x) => x.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json({
    ...run,
    links: {
      trace: `${signoz()}/traces?trace_id=${run.traceId}`,
      dashboard: `${signoz()}/dashboards`,
      alerts: `${signoz()}/alerts`,
    },
  });
});
app.get("/api/runs/:runId/agents/:agentId", async (req, res) => {
  const run = runs.find((entry) => entry.id === req.params.runId);
  const agent = run?.agents.find((entry) => entry.id === req.params.agentId);
  if (!run || !agent) return res.status(404).json({ error:"Agent run not found" });
  const evidence = await evidenceForAgent({ runId:run.id, traceId:agent.traceId || run.traceId, agentId:agent.id, status:agent.status, retries:agent.retries, error:agent.error, runStatus:run.status, totalTokens:run.totalTokens, budget:run.budget });
  res.json({ runId:run.id, agent, evidence, links:{ dashboard:`${signoz()}/dashboards`, preview:run.previewUrl } });
});
app.get("/api/preview/:id", (req, res) => {
  const run = ["latest", "demo"].includes(req.params.id)
    ? runs[0]
    : runs.find((x) => x.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json({
    projectName: "Generated mobile app",
    brief: run.brief,
    agents: run.agents,
    mobilePlan: run.mobilePlan || fallbackPlan(run.brief),
  });
});
app.listen(Number(process.env.PORT || 4310), () =>
  console.log("Faultline runner listening on 4310"),
);
