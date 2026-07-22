export type EvidenceCapsule = {
  kind: 'trace'|'logs'|'risk';
  tone: 'good'|'warn'|'bad'|'muted';
  title: string;
  detail: string;
  action: string;
  href: string;
};

type AgentEvidenceInput = {
  runId:string; traceId:string; agentId:string; status:string; retries:number; error?:string;
  runStatus:string; totalTokens:number; budget:number;
};

const ui = () => process.env.SIGNOZ_UI_URL || 'http://localhost:8080';
const logsHref = (input:AgentEvidenceInput) => `${ui()}/logs?query=${encodeURIComponent(`faultline.run_id=${input.runId} AND faultline.agent_id=${input.agentId}`)}`;

async function available():Promise<boolean> {
  try {
    const response = await fetch(ui(), { signal:AbortSignal.timeout(700) });
    return response.ok;
  } catch { return false; }
}

export async function evidenceForAgent(input:AgentEvidenceInput):Promise<EvidenceCapsule[]> {
  const connected = await available();
  const traceHref = `${ui()}/traces?trace_id=${input.traceId}`;
  if (!connected) return [
    { kind:'trace', tone:'muted', title:'Telemetry temporarily unavailable', detail:'Faultline retained this agent context; SigNoz could not be reached.', action:'Open SigNoz', href:ui() },
  ];

  const risk = input.error
    ? { tone:'warn' as const, title:'Recovered retry recorded', detail:input.error, action:'Open correlated logs', href:logsHref(input) }
    : input.status === 'failed'
      ? { tone:'bad' as const, title:'Agent failure recorded', detail:'The agent stopped before writing its artifact.', action:'Open correlated logs', href:logsHref(input) }
      : input.totalTokens > input.budget
        ? { tone:'warn' as const, title:'Budget breach recorded', detail:'Run usage exceeded its configured token budget.', action:'Open alert', href:`${ui()}/alerts` }
        : { tone:'good' as const, title:'No active risk', detail:'No failure or budget breach is associated with this agent.', action:'Open dashboard', href:`${ui()}/dashboards` };
  return [
    { kind:'trace', tone:input.status === 'failed' ? 'bad' : 'good', title:input.traceId ? 'Trace correlated' : 'Trace pending', detail:input.traceId ? 'Execution is linked to the run trace in SigNoz.' : 'Trace ID will be available when the run closes.', action:'Open trace', href:traceHref },
    { kind:'logs', tone:'good', title:'I/O captured', detail:'Prompt, response, retries, and artifact events are correlated.', action:'Open correlated logs', href:logsHref(input) },
    { kind:'risk', ...risk },
  ];
}
