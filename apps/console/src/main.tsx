import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, ArrowUpRight, CheckCircle2, ChevronRight, CircleAlert, Clipboard, FileCode2, Play, Radio, RefreshCw, ShieldAlert, Timer, Wallet } from "lucide-react";
import "./styles.css";

type Event = { at:string; type:string; detail:string; tone:"info"|"good"|"warn"|"bad" };
type Agent = { id:string; name:string; status:string; duration:number; tokens:number; retries:number; decision:string; artifact:string; error?:string; systemPrompt:string; taskPrompt:string; model:string; output:string; artifactContent:string; traceId:string; spanId:string; events:Event[] };
type Run = { id:string; brief:string; scenario:string; status:string; startedAt:string; traceId:string; totalTokens:number; budget:number; agents:Agent[]; previewUrl:string; error?:string };
type Capsule = { kind:string; tone:string; title:string; detail:string; action:string; href:string };
type Dossier = { runId:string; agent:Agent; evidence:Capsule[]; links:{dashboard:string;preview:string} };
const API = "http://localhost:4310";

const preferredAgent = (run:Run) => run.agents.find(agent => agent.status === "working") ?? run.agents.find(agent => agent.status === "risk" || agent.status === "failed") ?? run.agents[0];
const copy = (value:string) => void navigator.clipboard?.writeText(value);

function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<Run | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [scenario, setScenario] = useState("healthy");
  const [brief, setBrief] = useState("A shared household budget app with weekly spending insights");
  const [loading, setLoading] = useState(false);

  const chooseRun = (run:Run) => { setSelected(run); setAgentId(preferredAgent(run)?.id ?? null); };
  const load = async () => {
    try {
      const next:Run[] = await fetch(`${API}/api/runs`).then(response => response.json());
      setRuns(next);
      setSelected(current => {
        const updated = current ? next.find(run => run.id === current.id) : next[0];
        if (updated) setAgentId(active => active && updated.agents.some(agent => agent.id === active) ? active : preferredAgent(updated)?.id ?? null);
        return updated ?? current ?? null;
      });
    } catch { /* Retain the active investigation while the runner reconnects. */ }
  };

  useEffect(() => { void load(); const interval = setInterval(load, 1000); return () => clearInterval(interval); }, []);
  useEffect(() => {
    if (!selected || !agentId) return;
    let active = true;
    fetch(`${API}/api/runs/${selected.id}/agents/${agentId}`).then(response => response.ok ? response.json() : null).then(payload => { if (active) setDossier(payload); }).catch(() => { if (active) setDossier(null); });
    return () => { active = false; };
  }, [selected, agentId]);

  const launch = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API}/api/runs`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({brief, scenario}) });
      const run:Run = await response.json();
      if (!response.ok) throw Error((run as unknown as {error:string}).error);
      setRuns(current => [run, ...current]); chooseRun(run);
    } catch (error) { alert(error instanceof Error ? error.message : "Run failed"); } finally { setLoading(false); }
  };

  const risk = !!selected && selected.totalTokens > selected.budget;
  const activeAgent = dossier?.agent ?? selected?.agents.find(agent => agent.id === agentId);
  const runLabel = (run:Run) => run.status === "running" ? "Mobile build in progress" : run.scenario === "incident" ? "Injected incident" : "Healthy mobile build";
  const runStatus = selected?.status === "running" ? "Agents working" : selected?.status === "attention" ? "Needs attention" : selected?.status === "failed" ? "Run failed" : "Healthy";

  return <main>
    <header><div className="brand"><Radio size={18}/><span>FAULTLINE</span><b>operator console</b></div><div className="health"><i/> SIGNoz connected <span>self-hosted</span></div></header>
    <section className="launch"><div><p className="eyebrow">CONTROLLED WORKLOAD</p><h1>See why an agent run<br/>went sideways.</h1><textarea value={brief} onChange={event => setBrief(event.target.value)}/><div className="actions"><div className="seg"><button className={scenario === "healthy" ? "on" : ""} onClick={() => setScenario("healthy")}>Healthy run</button><button className={scenario === "incident" ? "on danger" : ""} onClick={() => setScenario("incident")}>Injected incident</button></div><button className="launchBtn" disabled={loading} onClick={launch}><Play size={15}/>{loading ? "Starting agents…" : "Run mobile build"}</button></div></div><div className="ribbon" aria-label="Agent trace ribbon"><span className="dot one"/><span className="dot two"/><span className="dot three"/><span className="dot four"/><p>planner / architecture / design / preview</p></div></section>
    <div className="workspace">
      <aside><div className="sectionTitle">RUN INBOX <button onClick={load} title="Refresh runs"><RefreshCw size={14}/></button></div>{runs.length === 0 ? <div className="empty">Run a mobile build to begin the investigation.</div> : runs.map(run => <button key={run.id} className={'run ' + (selected?.id === run.id ? 'selected' : '')} onClick={() => chooseRun(run)}><span className={'status ' + run.status}/><div><strong>{runLabel(run)}</strong><small>{new Date(run.startedAt).toLocaleTimeString()} · {run.totalTokens} tokens</small></div><ChevronRight size={15}/></button>)}</aside>
      <section className="map"><div className="sectionTitle">CAUSAL PATH {selected?.traceId && <small>{selected.traceId.slice(0, 12)}</small>}</div>{selected ? <><div className="runMeta"><span className={selected.status === "attention" || selected.status === "failed" ? "attention" : "good"}>{selected.status === "attention" || selected.status === "failed" ? <ShieldAlert size={15}/> : <CheckCircle2 size={15}/>} {runStatus}</span><span><Wallet size={14}/>{selected.totalTokens} / {selected.budget} tokens</span><span><Timer size={14}/> {selected.agents.reduce((total, agent) => total + agent.duration, 0)}ms critical path</span></div><div className="traceMap">{selected.agents.map((agent, index) => <React.Fragment key={agent.id}><button className={'node ' + agent.status + (agentId === agent.id ? ' focused' : '')} onClick={() => setAgentId(agent.id)}><span>{index + 1}</span><b>{agent.name}</b><small>{agent.status === "queued" ? "queued" : agent.status === "working" ? "working…" : `${agent.duration}ms · ${agent.tokens} tok`}</small></button>{index < selected.agents.length - 1 && <div className="line"/>}</React.Fragment>)}</div><div className="impact"><p className="eyebrow">OPERATOR READOUT</p><h2>{selected.status === "running" ? "Agents are publishing their decisions as they finish." : risk ? "The run exceeded its token budget." : selected.status === "failed" ? "The run stopped before the preview was published." : "The run completed within its operating budget."}</h2><p>{selected.status === "running" ? "Select an agent to inspect its prompt, response, and live execution trail." : selected.status === "attention" ? "Architecture retried after an injected gateway timeout. The retry recovered, but live model usage crossed the run budget." : selected.error || "All agents completed without retries or budget breaches."}</p></div></> : <div className="empty">Select a run.</div>}</section>
      <aside className="inspector"><div className="sectionTitle">AGENT INSPECTOR</div>{activeAgent ? <><div className="agentHeading"><div><b>{activeAgent.name}</b><small>{activeAgent.status} · {activeAgent.artifact}</small></div><span className={'agentState ' + activeAgent.status}>{activeAgent.status}</span></div><section className="capsules"><p className="eyebrow">VERIFIED BY SIGNOZ</p>{dossier?.evidence.map(capsule => <a key={capsule.kind} className={'capsule ' + capsule.tone} href={capsule.href} target="_blank"><div><b>{capsule.title}</b><small>{capsule.detail}</small></div><span>{capsule.action}<ArrowUpRight size={12}/></span></a>) ?? <div className="capsule muted"><div><b>Loading telemetry evidence</b><small>Agent context is available while SigNoz evidence resolves.</small></div></div>}</section><section className="decision"><p className="eyebrow">DECISION</p><p>{activeAgent.error || activeAgent.decision}</p><small>Recommended action: {activeAgent.status === "failed" ? "Inspect correlated logs and retry the run." : activeAgent.retries ? "Verify the recovered retry in the trace." : "Continue to the next agent or review the artifact."}</small></section><CodeBlock label="SYSTEM PROMPT" value={activeAgent.systemPrompt || "Preparing prompt…"}/><CodeBlock label="TASK PROMPT" value={activeAgent.taskPrompt || "Waiting for this agent to start…"}/><CodeBlock label="MODEL OUTPUT" value={activeAgent.output || "Waiting for the model response…"}/><section className="execution"><p className="eyebrow">EXECUTION</p>{activeAgent.events.length ? activeAgent.events.map((event, index) => <div className={'event ' + event.tone} key={`${event.at}-${index}`}><i/><div><b>{event.type}</b><small>{event.detail}</small></div><time>{new Date(event.at).toLocaleTimeString()}</time></div>) : <div className="empty compact">Events will appear when this agent begins.</div>}</section><div className="inspectorLinks">{dossier && <a href={dossier.links.dashboard} target="_blank">Open SigNoz dashboard <ArrowUpRight size={14}/></a>}{selected && selected.status !== "running" && selected.status !== "failed" && <a className="preview" href={selected.previewUrl} target="_blank">Open Expo preview <ArrowUpRight size={14}/></a>}</div></> : <div className="empty">Select an agent in the causal path.</div>}</aside>
    </div>
    <footer className="credit"><span>Built by <a href="https://harishkotra.me" target="_blank" rel="noreferrer">Harish Kotra</a></span><span>Explore <a href="https://dailybuild.xyz" target="_blank" rel="noreferrer">more builds</a></span></footer>
  </main>;
}

function CodeBlock({label, value}:{label:string;value:string}) { return <section className="codeBlock"><div><p className="eyebrow">{label}</p><button title={`Copy ${label.toLowerCase()}`} onClick={() => copy(value)}><Clipboard size={13}/></button></div><pre>{value}</pre></section>; }
createRoot(document.getElementById("root")!).render(<App/>);
