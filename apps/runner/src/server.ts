import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { bootWorkspace, writeArtifact } from './bridge.js';
import { flushTelemetry, inSpan, telemetry } from './telemetry.js';

// Workspace scripts run from apps/runner; always load Faultline's root config.
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

type Scenario = 'healthy' | 'incident';
type Agent = { id:string; name:string; status:'complete'|'risk'; duration:number; tokens:number; retries:number; decision:string; artifact:string; error?:string };
type Run = { id:string; brief:string; scenario:Scenario; status:'healthy'|'attention'; startedAt:string; traceId:string; totalTokens:number; budget:number; agents:Agent[]; previewUrl:string };
const app = express(); const runs:Run[]=[]; app.use(cors()); app.use(express.json());
const signoz=()=>process.env.SIGNOZ_UI_URL||'http://localhost:8080';

async function invokeModel(prompt:string) {
  const base=(process.env.OPENAI_BASE_URL||'').replace(/\/$/,''); const key=process.env.OPENAI_API_KEY||'';
  if(!base||!key) throw new Error('Missing OPENAI_BASE_URL or OPENAI_API_KEY');
  const res=await fetch(`${base}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({model:process.env.OPENAI_MODEL||'openai/gpt-4o-mini',messages:[{role:'system',content:'Return one concise mobile app implementation decision.'},{role:'user',content:prompt}],max_tokens:220})});
  if(!res.ok) throw new Error(`LLM ${res.status}`); const data:any=await res.json(); return {tokens:data.usage?.total_tokens||120,decision:data.choices?.[0]?.message?.content?.slice(0,180)||'Generated mobile screen contract'};
}

app.get('/health',(_q,res)=>res.json({ok:true,service:'faultline-runner',signoz:signoz(),bridge:process.env.FAULTLINE_BRIDGE_URL||'http://localhost:4320'}));
app.get('/api/runs',(_q,res)=>res.json([...runs].sort((a,b)=>Number(b.status==='attention')-Number(a.status==='attention')||b.startedAt.localeCompare(a.startedAt))));
app.post('/api/runs',async(req,res)=>{
  const brief=String(req.body.brief||'A personal finance app for shared household budgets'); const scenario:Scenario=req.body.scenario==='incident'?'incident':'healthy'; const id=randomUUID(); const budget=scenario==='incident'?80:1200; const agents:Agent[]=[]; let total=0;
  try {
    const root=await inSpan('agent.run',{'faultline.run_id':id,'faultline.scenario':scenario,'faultline.budget_tokens':budget},async()=>{
      const pipeline=[['planner','Plan','app-plan.json'],['architecture','Architecture','routes.ts'],['design','Design system','tokens.ts'],['primary','Primary screen','HomeScreen.tsx']] as const;
      for(const [index,[agent,name,artifact]] of pipeline.entries()) await inSpan(`agent.${agent}`,{'faultline.run_id':id,'faultline.agent_id':agent},async()=>{
        await bootWorkspace(id,agent,brief); let retries=0; let error:string|undefined;
        if(scenario==='incident'&&index===1){retries=1;error='Injected timeout: upstream model gateway exceeded 250ms';telemetry.retries.add(1,{agent});await inSpan('agent.retry',{'faultline.injected':true,'faultline.reason':'timeout','faultline.agent_id':agent},async()=>{await new Promise(r=>setTimeout(r,80));return null});}
        const llm=await inSpan('llm.chat.completions',{'gen_ai.system':'openai-compatible','gen_ai.request.model':process.env.OPENAI_MODEL||'openai/gpt-4o-mini','faultline.agent_id':agent},()=>invokeModel(`${brief}\nAgent: ${name}`));
        total+=llm.value.tokens; telemetry.tokens.add(llm.value.tokens,{agent}); telemetry.duration.record(220+index*90,{agent}); await writeArtifact(id,agent,artifact,llm.value.decision);
        agents.push({id:agent,name,status:error?'risk':'complete',duration:220+index*90,tokens:llm.value.tokens,retries,decision:llm.value.decision,artifact,error}); return null;
      }); return null;
    });
    const breached=total>budget; if(breached)telemetry.breaches.add(1,{scenario}); telemetry.runs.add(1,{outcome:breached?'attention':'healthy'});
    await flushTelemetry();
    const run:Run={id,brief,scenario,status:breached||scenario==='incident'?'attention':'healthy',startedAt:new Date().toISOString(),traceId:root.traceId,totalTokens:total,budget,agents,previewUrl:`http://localhost:8081/?run=${id}`}; runs.unshift(run); res.status(201).json(run);
  } catch(error){res.status(502).json({error:error instanceof Error?error.message:String(error)});}
});
app.get('/api/runs/:id',(req,res)=>{const run=runs.find(x=>x.id===req.params.id);if(!run)return res.status(404).json({error:'Run not found'});res.json({...run,links:{trace:`${signoz()}/traces?trace_id=${run.traceId}`,dashboard:`${signoz()}/dashboards`,alerts:`${signoz()}/alerts`}})});
app.get('/api/preview/:id',(req,res)=>{const run=['latest','demo'].includes(req.params.id)?runs[0]:runs.find(x=>x.id===req.params.id);if(!run)return res.status(404).json({error:'Run not found'});res.json({projectName:'Generated mobile app',brief:run.brief,agents:run.agents})});
app.listen(Number(process.env.PORT||4310),()=>console.log('Faultline runner listening on 4310'));
