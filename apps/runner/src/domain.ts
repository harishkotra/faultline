export type Scenario = "healthy" | "incident";
export type AgentStatus = "queued" | "working" | "complete" | "risk" | "failed" | "reused";
export type RunStatus = "running" | "healthy" | "attention" | "failed";
export type ExecutionEvent = { at:string; type:string; detail:string; tone:"info"|"good"|"warn"|"bad" };
export type Classification = "provider_rate_limit" | "timeout" | "missing_configuration" | "budget_exhausted" | "invalid_model_response" | "telemetry_unavailable" | "unknown";

export type Agent = {
  id:string; name:string; status:AgentStatus; duration:number; tokens:number; retries:number;
  decision:string; artifact:string; error?:string; systemPrompt:string; taskPrompt:string;
  model:string; output:string; artifactContent:string; traceId:string; spanId:string;
  events:ExecutionEvent[];
};
export type MobilePlan = {
  appName:string; greeting:string; balanceLabel:string; balance:string; balanceChange:string;
  actionLabel:string; categories:Array<{name:string;amount:string;color:string}>;
  activity:Array<{title:string;meta:string;amount:string}>; insightTitle:string; insightCopy:string;
};
export type RecoveryConfig = { taskPrompt:string; model:string; budget:number };
export type Run = {
  id:string; brief:string; scenario:Scenario; status:RunStatus; startedAt:string; traceId:string;
  totalTokens:number; budget:number; agents:Agent[]; previewUrl:string; mobilePlan?:MobilePlan;
  error?:string; parentRunId?:string; recoveryAgentId?:string; recoveryNumber?:number;
  sourceTraceId?:string; recoveryConfig?:RecoveryConfig; reusedAgentIds?:string[];
  classification?:Classification; fingerprint?:string;
};

export const pipeline = [
  ["planner", "Plan", "app-plan.json"],
  ["architecture", "Architecture", "routes.ts"],
  ["design", "Design system", "tokens.ts"],
  ["primary", "Primary screen", "HomeScreen.tsx"],
] as const;

export const terminal = (status:RunStatus) => status !== "running";

export function classifyIncident(error?:string):Classification {
  const message = (error || "").toLowerCase();
  if (message.includes("429") || message.includes("rate limit")) return "provider_rate_limit";
  if (message.includes("timeout")) return "timeout";
  if (message.includes("missing openai") || message.includes("missing configuration")) return "missing_configuration";
  if (message.includes("budget")) return "budget_exhausted";
  if (message.includes("invalid model") || message.includes("empty model")) return "invalid_model_response";
  if (message.includes("telemetry")) return "telemetry_unavailable";
  return "unknown";
}

export function fingerprint(agentId:string | undefined, classification:Classification):string {
  return `${agentId || "run"}:${classification}`;
}

export function createAgents(systemPrompt:string, model:string):Agent[] {
  return pipeline.map(([id, name, artifact]) => ({
    id, name, status:"queued", duration:0, tokens:0, retries:0,
    decision:"Waiting for the preceding agent...", artifact, systemPrompt, taskPrompt:"", model,
    output:"", artifactContent:"", traceId:"", spanId:"", events:[],
  }));
}

export function recoveryAgents(source:Run, recoveryAgentId:string):Agent[] {
  const start = pipeline.findIndex(([id]) => id === recoveryAgentId);
  return source.agents.map((agent, index) => index < start ? {
    ...agent, status:"reused", duration:0, tokens:0, retries:0, error:undefined,
    events:[...agent.events, { at:new Date().toISOString(), type:"Upstream artifact reused", detail:"Preserved from the source run as read-only context.", tone:"info" }],
  } : {
    ...agent, status:"queued", duration:0, tokens:0, retries:0, error:undefined,
    decision:"Waiting for recovery execution...", taskPrompt:"", output:"", artifactContent:"", traceId:"", spanId:"", events:[],
  });
}

export function recommendedAction(classification:Classification):string {
  return {
    provider_rate_limit:"Wait for the provider reset, add quota, or select a model with available capacity.",
    timeout:"Review the retry evidence, then rerun this agent with a focused prompt.",
    missing_configuration:"Configure the OpenAI-compatible base URL and API key before retrying.",
    budget_exhausted:"Increase the recovery budget or rerun from a later agent with a narrower task.",
    invalid_model_response:"Adjust the task prompt or choose a model that returns a usable response.",
    telemetry_unavailable:"Restore the SigNoz collector, then reopen the correlated trace.",
    unknown:"Inspect correlated logs, adjust the recovery inputs, and rerun the affected agent.",
  }[classification];
}
