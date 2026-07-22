const base=()=>process.env.FAULTLINE_BRIDGE_URL||'http://localhost:4320';
async function call(path:string,body:unknown){const res=await fetch(`${base()}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!res.ok)throw new Error(`Bridge ${res.status}`);return res.json();}
export async function bootWorkspace(runId:string,agentId:string,brief:string){return call('/api/workspaces/boot',{key:`${runId}-${agentId}`,agentId,brief});}
export async function writeArtifact(runId:string,agentId:string,path:string,content:string){return call('/api/workspaces/write',{key:`${runId}-${agentId}`,path,content});}
