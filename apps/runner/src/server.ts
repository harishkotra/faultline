import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { randomUUID } from "node:crypto";
import { bootWorkspace, writeArtifact } from "./bridge.js";
import { currentTraceRef, flushTelemetry, inSpan, logEvent, telemetry } from "./telemetry.js";
import { evidenceForAgent } from "./signoz.js";
import { classifyIncident, createAgents, fingerprint, pipeline, recommendedAction, recoveryAgents, terminal, type Agent, type Classification, type MobilePlan, type RecoveryConfig, type Run, type Scenario } from "./domain.js";
import { loadJournal, persistJournal } from "./journal.js";

dotenv.config({ path:fileURLToPath(new URL("../../../.env", import.meta.url)) });

const app = express();
const runs:Run[] = await loadJournal();
for (const run of runs) {
  if (run.status === "attention" && !run.fingerprint) {
    const riskAgent = run.agents.find(agent => agent.status === "risk");
    run.classification = run.totalTokens > run.budget ? "budget_exhausted" : classifyIncident(riskAgent?.error);
    run.fingerprint = fingerprint(riskAgent?.id, run.classification);
  }
}
app.use(cors());
app.use(express.json());

const signoz = () => process.env.SIGNOZ_UI_URL || "http://localhost:8080";
const systemPrompt = "Return one concise mobile app implementation decision.";
const defaultModel = () => process.env.OPENAI_MODEL || "openai/gpt-4o-mini";
const persist = () => void persistJournal(runs);
const record = (agent:Agent, type:string, detail:string, tone:"info"|"good"|"warn"|"bad"="info") => agent.events.push({ at:new Date().toISOString(), type, detail, tone });

async function invokeModel(prompt:string, model:string, maxTokens:number) {
  const base = (process.env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  const key = process.env.OPENAI_API_KEY || "";
  if (!base || !key) throw new Error("Missing OPENAI_BASE_URL or OPENAI_API_KEY");
  const response = await fetch(`${base}/chat/completions`, {
    method:"POST", headers:{ "content-type":"application/json", authorization:`Bearer ${key}` },
    body:JSON.stringify({ model, max_tokens:maxTokens, messages:[{ role:"system", content:systemPrompt }, { role:"user", content:prompt }] }),
  });
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const resetAt = response.headers.get("x-ratelimit-reset");
    const body = await response.json().catch(() => ({})) as { error?:{ message?:unknown } };
    const providerMessage = typeof body.error?.message === "string" ? body.error.message.replace(/\s+/g, " ").slice(0, 280) : "The upstream provider rejected this request.";
    const retryHint = retryAfter ? ` Retry after ${retryAfter}s.` : resetAt ? " Retry after the provider's rate-limit reset." : "";
    throw new Error(`LLM ${response.status}: ${providerMessage}${retryHint}`);
  }
  const data:any = await response.json();
  const decision = data.choices?.[0]?.message?.content;
  if (typeof decision !== "string" || !decision.trim()) throw new Error("Invalid model response: the provider returned no decision content.");
  return { tokens:Math.max(1, Number(data.usage?.total_tokens) || 120), decision:decision.trim() };
}

const fallbackPlan = (brief:string):MobilePlan => ({
  appName:brief.toLowerCase().includes("budget") ? "Gather" : "Daymark", greeting:"Good morning, Alex",
  balanceLabel:brief.toLowerCase().includes("budget") ? "Available this week" : "Today at a glance",
  balance:brief.toLowerCase().includes("budget") ? "$842.60" : "4 priorities",
  balanceChange:brief.toLowerCase().includes("budget") ? "+$126 from last week" : "2 complete since yesterday",
  actionLabel:brief.toLowerCase().includes("budget") ? "Add expense" : "Add item",
  categories:[{name:"Essentials",amount:"$412",color:"#5d71e9"},{name:"Shared plans",amount:"$168",color:"#e39162"},{name:"Free time",amount:"$94",color:"#6fb9a8"}],
  activity:[{title:"Weekly plan updated",meta:"Just now",amount:"+ $126"},{title:"Groceries",meta:"Today, 10:32 AM",amount:"- $58.40"},{title:"Rent contribution",meta:"Yesterday",amount:"- $320.00"}],
  insightTitle:"You are pacing well", insightCopy:"Your weekly plan is on track. Essentials account for the largest share of activity.",
});

async function invokeMobilePlan(brief:string, model:string):Promise<MobilePlan> {
  const base = (process.env.OPENAI_BASE_URL || "").replace(/\/$/, ""); const key = process.env.OPENAI_API_KEY || "";
  if (!base || !key) return fallbackPlan(brief);
  const response = await fetch(`${base}/chat/completions`, { method:"POST", headers:{ "content-type":"application/json", authorization:`Bearer ${key}` }, body:JSON.stringify({ model, max_tokens:500, messages:[{role:"system",content:"Return only valid JSON. Create a concise mobile app preview spec with appName, greeting, balanceLabel, balance, balanceChange, actionLabel, categories (3 objects: name, amount, color hex), activity (3 objects: title, meta, amount), insightTitle, insightCopy."},{role:"user",content:`App brief: ${brief}`}] }) });
  if (!response.ok) return fallbackPlan(brief);
  const data:any = await response.json(); const raw = String(data.choices?.[0]?.message?.content || "").replace(/^```json\s*|\s*```$/g, "");
  try { return { ...fallbackPlan(brief), ...JSON.parse(raw) }; } catch { return fallbackPlan(brief); }
}

function taskFor(run:Run, index:number):string {
  const [agent, name] = pipeline[index];
  if (index === pipeline.findIndex(([id]) => id === run.recoveryAgentId)) return run.recoveryConfig?.taskPrompt || `${run.brief}\nAgent: ${name}`;
  const context = run.agents.slice(0, index).filter(entry => entry.output).map(entry => `${entry.name}: ${entry.output}`).join("\n");
  return `${run.brief}\nAgent: ${name}${context ? `\nUpstream artifact context:\n${context}` : ""}`;
}

async function executeRun(run:Run) {
  let total = 0;
  const startIndex = run.recoveryAgentId ? pipeline.findIndex(([id]) => id === run.recoveryAgentId) : 0;
  const model = run.recoveryConfig?.model || defaultModel();
  try {
    const root = await inSpan("agent.run", {
      "faultline.run_id":run.id, "faultline.scenario":run.scenario, "faultline.budget_tokens":run.budget,
      ...(run.parentRunId ? { "faultline.parent_run_id":run.parentRunId, "faultline.recovery_agent_id":run.recoveryAgentId || "", "faultline.recovery_number":run.recoveryNumber || 0, "faultline.source_trace_id":run.sourceTraceId || "" } : {}),
    }, async () => {
      for (const [index, [agentId, name, artifact]] of pipeline.entries()) {
        if (index < startIndex) continue;
        if (run.parentRunId && total >= run.budget) throw new Error(`Recovery budget exhausted before ${name}.`);
        await inSpan(`agent.${agentId}`, { "faultline.run_id":run.id, "faultline.agent_id":agentId, ...(run.parentRunId ? { "faultline.parent_run_id":run.parentRunId } : {}) }, async () => {
          const current = run.agents[index]; const taskPrompt = taskFor(run, index); const traceRef = currentTraceRef();
          current.traceId = traceRef.traceId; current.spanId = traceRef.spanId; run.traceId ||= traceRef.traceId;
          current.taskPrompt = taskPrompt; current.model = model; current.status = "working"; current.decision = "Preparing isolated agent workspace...";
          record(current, "Workspace started", "Booting isolated agent workspace.");
          logEvent("faultline.workspace.started", { "faultline.event":"workspace.start", "faultline.run_id":run.id, "faultline.agent_id":agentId, "faultline.scenario":run.scenario });
          logEvent(systemPrompt, { "faultline.event":"model.request", "faultline.run_id":run.id, "faultline.agent_id":agentId, "faultline.prompt_type":"system" });
          persist(); await bootWorkspace(run.id, agentId, run.brief);
          let retries = 0; let warning:string | undefined;
          if (run.scenario === "incident" && !run.parentRunId && index === 1) {
            retries = 1; warning = "Injected timeout: upstream model gateway exceeded 250ms"; current.retries = retries; current.error = warning;
            current.decision = "Timeout recorded. Retrying the model request..."; record(current, "Timeout recorded", warning, "warn");
            logEvent("faultline.retry", { "faultline.event":"retry", "faultline.run_id":run.id, "faultline.agent_id":agentId, "faultline.reason":"timeout", "faultline.attempt":2 }); telemetry.retries.add(1, { agent:agentId }); persist();
            await inSpan("agent.retry", { "faultline.injected":true, "faultline.reason":"timeout", "faultline.agent_id":agentId }, async () => { await new Promise(resolve => setTimeout(resolve, 80)); return null; });
          }
          const remaining = run.parentRunId ? Math.max(1, run.budget - total) : 220;
          const llm = await inSpan("llm.chat.completions", { "gen_ai.system":"openai-compatible", "gen_ai.request.model":model, "faultline.agent_id":agentId, "faultline.token_limit":Math.min(220, remaining) }, () => {
            record(current, "Model request", `Sending full prompt to ${model}.`); logEvent(taskPrompt, { "faultline.event":"model.request", "faultline.run_id":run.id, "faultline.agent_id":agentId, "faultline.prompt_type":"user" }); persist();
            return invokeModel(taskPrompt, model, Math.min(220, remaining));
          });
          total += llm.value.tokens; run.totalTokens = total; telemetry.tokens.add(llm.value.tokens, { agent:agentId }); telemetry.duration.record(220 + index * 90, { agent:agentId });
          await writeArtifact(run.id, agentId, artifact, llm.value.decision);
          record(current, "Model response", "Model completed its implementation decision.", "good"); record(current, "Artifact written", `Published ${artifact}.`, "good");
          logEvent(llm.value.decision, { "faultline.event":"model.response", "faultline.run_id":run.id, "faultline.agent_id":agentId, "faultline.output_type":"decision" }); logEvent(`Artifact written: ${artifact}`, { "faultline.event":"artifact.write", "faultline.run_id":run.id, "faultline.agent_id":agentId, "faultline.artifact":artifact });
          Object.assign(current, { status:warning ? "risk" : "complete", duration:220 + index * 90, tokens:llm.value.tokens, retries, decision:llm.value.decision, artifact, error:warning, output:llm.value.decision, artifactContent:llm.value.decision });
          if (agentId === "primary") { run.mobilePlan = await invokeMobilePlan(run.brief, model); record(current, "Preview screen model generated", "Generated interactive mobile screen content.", "good"); logEvent(JSON.stringify(run.mobilePlan), { "faultline.event":"preview.model", "faultline.run_id":run.id, "faultline.agent_id":agentId }); }
          persist(); return null;
        });
      }
      logEvent("faultline.preview.published", { "faultline.event":"preview.publish", "faultline.run_id":run.id }); return null;
    });
    run.traceId = root.traceId || run.traceId;
    const breached = total > run.budget;
    if (breached) telemetry.breaches.add(1, { scenario:run.scenario });
    telemetry.runs.add(1, { outcome:breached ? "attention" : "healthy" });
    run.agents.filter(agent => agent.id === "primary" && agent.status !== "reused").forEach(agent => record(agent, "Preview published", "Expo preview is ready for operator review.", "good"));
    run.status = breached || run.scenario === "incident" ? "attention" : "healthy";
    if (run.status === "attention") {
      const riskAgent = run.agents.find(agent => agent.status === "risk");
      run.classification = breached ? "budget_exhausted" : classifyIncident(riskAgent?.error);
      run.fingerprint = fingerprint(riskAgent?.id, run.classification);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); const current = run.agents.find(agent => agent.status === "working");
    if (current) { current.status = "failed"; current.error = message; current.decision = "Agent failed before completing its artifact."; record(current, "Agent failed", message, "bad"); logEvent(message, { "faultline.event":"agent.failure", "faultline.run_id":run.id, "faultline.agent_id":current.id }); }
    run.status = "failed"; run.error = message; run.classification = classifyIncident(message); run.fingerprint = fingerprint(current?.id, run.classification); telemetry.runs.add(1, { outcome:"failed" });
  } finally { persist(); await flushTelemetry(); }
}

function createRun(brief:string, scenario:Scenario):Run {
  const id = randomUUID(); const budget = scenario === "incident" ? 80 : 1200;
  return { id, brief, scenario, status:"running", startedAt:new Date().toISOString(), traceId:"", totalTokens:0, budget, agents:createAgents(systemPrompt, defaultModel()), previewUrl:`http://localhost:8081/?run=${id}`, mobilePlan:fallbackPlan(brief) };
}

function comparison(source:Run, recovery?:Run) {
  const sourceAgent = source.recoveryAgentId ? source.agents.find(agent => agent.id === source.recoveryAgentId) : source.agents.find(agent => agent.status === "failed" || agent.status === "risk");
  const recoveryAgent = recovery?.recoveryAgentId ? recovery.agents.find(agent => agent.id === recovery.recoveryAgentId) : undefined;
  return { source, recovery:recovery || null, delta:recovery && sourceAgent && recoveryAgent ? {
    agentId:recoveryAgent.id, before:{ status:sourceAgent.status, reason:sourceAgent.error || source.error || "No active risk", duration:sourceAgent.duration, tokens:sourceAgent.tokens, retries:sourceAgent.retries, output:sourceAgent.output, artifact:sourceAgent.artifact, preview:source.previewUrl, trace:`${signoz()}/traces?trace_id=${source.traceId}` },
    after:{ status:recoveryAgent.status, reason:recoveryAgent.error || recovery.error || "Recovered without an active failure", duration:recoveryAgent.duration, tokens:recoveryAgent.tokens, retries:recoveryAgent.retries, output:recoveryAgent.output, artifact:recoveryAgent.artifact, preview:recovery.previewUrl, trace:`${signoz()}/traces?trace_id=${recovery.traceId}` },
  } : null };
}

app.get("/health", (_req, res) => res.json({ ok:true, service:"faultline-runner", signoz:signoz(), bridge:process.env.FAULTLINE_BRIDGE_URL || "http://localhost:4320", persistedRuns:runs.length }));
app.get("/api/runs", (_req, res) => {
  const grouped = new Map<string, number>(); runs.forEach(run => { if (run.fingerprint) grouped.set(run.fingerprint, (grouped.get(run.fingerprint) || 0) + 1); });
  res.json([...runs].sort((a,b) => Number(b.status === "attention" || b.status === "failed") - Number(a.status === "attention" || a.status === "failed") || Number(b.status === "running") - Number(a.status === "running") || b.startedAt.localeCompare(a.startedAt)).map(run => ({ ...run, recurrenceCount:run.fingerprint ? grouped.get(run.fingerprint) || 1 : 0 })));
});
app.post("/api/runs", (req, res) => { const run = createRun(String(req.body.brief || "A personal finance app for shared household budgets"), req.body.scenario === "incident" ? "incident" : "healthy"); runs.unshift(run); persist(); res.status(201).json(run); void executeRun(run); });
app.post("/api/runs/:runId/recoveries", (req, res) => {
  const source = runs.find(run => run.id === req.params.runId); if (!source) return res.status(404).json({ error:"Source run not found" });
  if (!terminal(source.status)) return res.status(409).json({ error:"Wait for the source run to finish before starting a recovery." });
  const agentId = String(req.body.agentId || ""); const sourceAgent = source.agents.find(agent => agent.id === agentId);
  if (!sourceAgent || !["failed", "risk"].includes(sourceAgent.status)) return res.status(422).json({ error:"Recoveries can start only from a failed or risk agent." });
  const taskPrompt = String(req.body.taskPrompt || "").trim(); const model = String(req.body.model || "").trim(); const budget = Number(req.body.budget);
  if (!taskPrompt) return res.status(422).json({ error:"A recovery task prompt is required." }); if (!model) return res.status(422).json({ error:"A recovery model is required." }); if (!Number.isInteger(budget) || budget < 1 || budget > 10000) return res.status(422).json({ error:"Recovery budget must be a whole number between 1 and 10000." });
  const recoveryNumber = runs.filter(run => run.parentRunId === source.id).length + 1; const id = randomUUID(); const config:RecoveryConfig = { taskPrompt, model, budget };
  const run:Run = { id, brief:source.brief, scenario:"healthy", status:"running", startedAt:new Date().toISOString(), traceId:"", totalTokens:0, budget, agents:recoveryAgents(source, agentId), previewUrl:`http://localhost:8081/?run=${id}`, mobilePlan:source.mobilePlan || fallbackPlan(source.brief), parentRunId:source.id, recoveryAgentId:agentId, recoveryNumber, sourceTraceId:source.traceId, recoveryConfig:config, reusedAgentIds:source.agents.slice(0, pipeline.findIndex(([entry]) => entry === agentId)).map(agent => agent.id) };
  runs.unshift(run); persist(); res.status(201).json(run); void executeRun(run);
});
app.get("/api/runs/:id", (req,res) => { const run = runs.find(entry => entry.id === req.params.id); if (!run) return res.status(404).json({ error:"Run not found" }); res.json({ ...run, links:{ trace:`${signoz()}/traces?trace_id=${run.traceId}`, dashboard:`${signoz()}/dashboards`, alerts:`${signoz()}/alerts` } }); });
app.get("/api/runs/:runId/comparison", (req,res) => { const selected = runs.find(entry => entry.id === req.params.runId); if (!selected) return res.status(404).json({ error:"Run not found" }); const source = selected.parentRunId ? runs.find(entry => entry.id === selected.parentRunId)! : selected; const recovery = selected.parentRunId ? selected : runs.filter(entry => entry.parentRunId === source.id).sort((a,b) => (b.recoveryNumber || 0) - (a.recoveryNumber || 0))[0]; res.json(comparison(source, recovery)); });
app.get("/api/runs/:runId/agents/:agentId", async (req,res) => { const run = runs.find(entry => entry.id === req.params.runId); const agent = run?.agents.find(entry => entry.id === req.params.agentId); if (!run || !agent) return res.status(404).json({ error:"Agent run not found" }); const evidence = await evidenceForAgent({ runId:run.id, traceId:agent.traceId || run.traceId, agentId:agent.id, status:agent.status, retries:agent.retries, error:agent.error, runStatus:run.status, totalTokens:run.totalTokens, budget:run.budget }); res.json({ runId:run.id, agent, evidence, classification:run.classification, recommendedAction:recommendedAction(run.classification || classifyIncident(agent.error)), links:{ dashboard:`${signoz()}/dashboards`, preview:run.previewUrl } }); });
app.get("/api/preview/:id", (req,res) => { const run = ["latest", "demo"].includes(req.params.id) ? runs[0] : runs.find(entry => entry.id === req.params.id); if (!run) return res.status(404).json({ error:"Run not found" }); res.json({ projectName:"Generated mobile app", brief:run.brief, agents:run.agents, mobilePlan:run.mobilePlan || fallbackPlan(run.brief) }); });

app.listen(Number(process.env.PORT || 4310), () => console.log("Faultline runner listening on 4310"));
