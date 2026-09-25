import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { reviewSchema,reviewJsonSchema,type Adapter,type PhaseResult } from '../../shared/contracts.js';
import { RpcClient } from './codex-rpc.js';
import { normalizeCodex } from './normalize.js';
const exec=promisify(execFile);
export function createCodexAdapter():Adapter {
 let active:RpcClient|undefined;
 return {
  async probe(){try{await exec('codex',['--version'],{timeout:5000});try{const r=await exec('codex',['login','status'],{timeout:5000});return {installed:true,authenticated:true,detail:(r.stdout||r.stderr).trim()};}catch{return {installed:true,authenticated:false,detail:'터미널에서 codex login을 실행해 주세요.'};}}catch{return {installed:false,authenticated:false,detail:'Codex CLI를 설치해 주세요.'};}},
  async execute(input,emit,interact){
   if(input.signal.aborted)return {outcome:'cancelled',text:''};
   const rpc=new RpcClient(spawn('codex',['app-server','--stdio'],{stdio:['pipe','pipe','pipe'],cwd:input.cwd}));active=rpc;
   let threadId='',turnId='',text='';let interruptTimer:NodeJS.Timeout|undefined;
   let finish:(r:PhaseResult)=>void;const done=new Promise<PhaseResult>(r=>{finish=r;});
   rpc.on('failure',(e:Error)=>finish({outcome:input.signal.aborted?'cancelled':'failed',text,error:e.message}));
   const abort=()=>{if(threadId&&turnId)void rpc.request('turn/interrupt',{threadId,turnId}).catch(()=>{});interruptTimer=setTimeout(()=>{void rpc.close();},3000);};
   input.signal.addEventListener('abort',abort,{once:true});
   rpc.on('message',(m:any)=>{
    for(const e of normalizeCodex(input.runId,m))emit(e);
    if(m.method==='item/agentMessage/delta')text+=m.params.delta??'';
    if(m.method==='item/completed'&&m.params?.item?.type==='agentMessage')text=m.params.item.text??text;
    if(m.method==='turn/started')turnId=m.params.turn.id;
    if(m.method==='turn/completed'){const t=m.params.turn;finish({outcome:input.signal.aborted||t.status==='interrupted'?'cancelled':t.status==='completed'?'completed':'failed',text,error:t.error?.message});}
    if(m.id!==undefined&&m.method){void (async()=>{
     const p=m.params??{};
     if(/requestUserInput$/.test(m.method)){
      const a=await interact({runId:input.runId,agentId:'codex',kind:'question',title:'Codex의 질문',details:p});
      rpc.respond(m.id,{answers:'answers'in a?Object.fromEntries(Object.entries(a.answers).map(([k,v])=>[k,{answers:v}])):{}});
     }else if(/requestApproval$/.test(m.method)){
      const a=await interact({runId:input.runId,agentId:'codex',kind:'approval',title:p.command??p.reason??'Codex 작업 승인',details:p});const allow='decision'in a&&a.decision==='approve';
      if(m.method.includes('/permissions/'))rpc.respond(m.id,{permissions:allow?p.permissions??{}:{},scope:'turn'});
      else rpc.respond(m.id,{decision:allow?'accept':'decline'});
     }else rpc.respond(m.id,{action:'decline'});
    })().catch(()=>{rpc.respond(m.id,{decision:'cancel'});});}
   });
   try{
    await rpc.request('initialize',{clientInfo:{name:'pixel_office',version:'0.1.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
    const t=await rpc.request('thread/start',{cwd:input.cwd,model:input.profile.model||undefined,approvalPolicy:'on-request',sandbox:input.role==='reviewer'?'read-only':'workspace-write',ephemeral:true,developerInstructions:'Work only on the user task in the specified working directory. Do not push, merge, change branches, or create other agents. Report actual validation outcomes. Respect the role instructions.'});threadId=t.thread.id;
    emit({runId:input.runId,agentId:'codex',type:'agent.session',payload:{sessionId:threadId,model:t.model??input.profile.model??'default'}});
    if(input.signal.aborted)return {outcome:'cancelled',text};
    const started=await rpc.request('turn/start',{threadId,input:[{type:'text',text:input.prompt}],...(input.role==='reviewer'?{outputSchema:reviewJsonSchema()}:{})});turnId=started.turn.id;
    if(input.signal.aborted)abort();
    const result=await done;
    if(result.outcome==='completed'&&input.role==='reviewer'){try{result.review=reviewSchema.parse(JSON.parse(result.text));}catch{result.error='검토 응답 형식을 확인할 수 없습니다.';}}
    return result;
   }catch(e){return {outcome:input.signal.aborted?'cancelled':'failed',text,error:(e as Error).message};}
   finally{input.signal.removeEventListener('abort',abort);if(interruptTimer)clearTimeout(interruptTimer);await rpc.close();if(active===rpc)active=undefined;}
  },async close(){await active?.close();}
 };
}
