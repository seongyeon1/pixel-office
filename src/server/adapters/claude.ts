import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { reviewSchema,reviewJsonSchema,type Adapter } from '../../shared/contracts.js';
import { isWithin } from '../projects.js';
import { normalizeClaude,activityForTool } from './normalize.js';
const exec=promisify(execFile);
export async function allowedFile(cwd:string,path:string){
 let target=resolve(cwd,path);while(true){try{target=await realpath(target);break;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')return false;const parent=dirname(target);if(parent===target)return false;target=parent;}}
 return isWithin(await realpath(cwd),target);
}
export function createClaudeAdapter():Adapter {
 let active:Query|undefined;
 return {
  async probe(){try{await exec('claude',['--version'],{timeout:5000});const r=await exec('claude',['auth','status'],{timeout:5000});const s=JSON.parse(r.stdout);return {installed:true,authenticated:!!s.loggedIn,detail:s.loggedIn?'Claude Code 로그인 연결':'터미널에서 claude auth login을 실행해 주세요.'};}catch{return {installed:false,authenticated:null,detail:'Claude Code 설치 및 로그인을 확인해 주세요.'};}},
  async execute(input,emit,interact){
   const abortController=new AbortController();const abort=()=>abortController.abort();input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort();
   let text='';let stderr='';
   try{
    const stream=query({prompt:input.prompt,options:{cwd:input.cwd,model:input.profile.model||undefined,abortController,settingSources:[],permissionMode:'default',includePartialMessages:true,maxTurns:30,
     tools:input.role==='reviewer'?['Read','Glob','Grep','Bash','AskUserQuestion']:['Read','Glob','Grep','Write','Edit','Bash','AskUserQuestion'],
     sandbox:{enabled:true,autoAllowBashIfSandboxed:false,allowUnsandboxedCommands:false,...(input.role==='reviewer'?{filesystem:{denyWrite:[input.cwd]}}:{})},
     ...(input.role==='reviewer'?{outputFormat:{type:'json_schema' as const,schema:reviewJsonSchema()}}:{}),
     stderr:(data)=>{stderr=(stderr+data).slice(-4000);},
     hooks:{PreToolUse:[{hooks:[async(h)=>{
      if(h.hook_event_name!=='PreToolUse')return {};
      const tool=h.tool_name;const args=h.tool_input as Record<string,unknown>;
      const deny=(reason:string)=>({hookSpecificOutput:{hookEventName:'PreToolUse' as const,permissionDecision:'deny' as const,permissionDecisionReason:reason}});
      if(input.role==='reviewer'&&['Edit','Write','NotebookEdit'].includes(tool))return deny('검토자는 소스 파일을 수정할 수 없습니다.');
      const path=args.file_path??args.path;
      if(typeof path==='string'&&!(await allowedFile(input.cwd,path)))return deny('작업 폴더 안의 파일만 접근할 수 있습니다.');
      emit({runId:input.runId,agentId:'claude',type:'activity',payload:{activity:activityForTool(tool),tool,input:args}});
      // Ask on every shell invocation, including otherwise auto-approved commands.
      if(tool==='Bash')return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'실행할 명령을 확인해 주세요.'}};
      return {};
     }]}]},
     canUseTool:async(tool,args)=>{
      if(input.signal.aborted)return {behavior:'deny',message:'작업이 중단되었습니다.'};
      const question=tool==='AskUserQuestion';
      const answer=await interact({runId:input.runId,agentId:'claude',kind:question?'question':'approval',title:question?'Claude의 질문':String(args.command??`${tool} 작업 승인`),details:{tool,...args}});
      if(question&&'answers'in answer)return {behavior:'allow',updatedInput:{...args,answers:Object.fromEntries(Object.entries(answer.answers).map(([k,v])=>[k,v.join(', ')]))}};
      return 'decision'in answer&&answer.decision==='approve'?{behavior:'allow',updatedInput:args}:{behavior:'deny',message:'사용자가 작업을 거절했습니다.'};
     }
    }});active=stream;
    for await(const m of stream){
     for(const e of normalizeClaude(input.runId,m))emit(e);
     if(m.type==='system'&&m.subtype==='init')emit({runId:input.runId,agentId:'claude',type:'agent.session',payload:{sessionId:m.session_id,model:m.model}});
     if(m.type==='stream_event'&&m.event.type==='content_block_delta'&&m.event.delta.type==='text_delta')text+=m.event.delta.text;
     if(m.type==='result'){
      if(input.signal.aborted)return {outcome:'cancelled',text};
      if(m.is_error||m.subtype!=='success')return {outcome:'failed',text,error:'errors'in m?m.errors.join('\n'):'Claude 실행 실패'};
      const parsed=input.role==='reviewer'?reviewSchema.safeParse(m.structured_output):undefined;
      return {outcome:'completed',text:m.result||text,review:parsed?.success?parsed.data:undefined,error:parsed&&!parsed.success?'검토 응답 형식을 확인할 수 없습니다.':undefined};
     }
    }
    return {outcome:input.signal.aborted?'cancelled':'failed',text,error:'Claude가 최종 결과 없이 종료되었습니다. '+stderr.slice(-1000)};
   }catch(e){return {outcome:input.signal.aborted?'cancelled':'failed',text,error:(e as Error).message+' '+stderr.slice(-1000)};}
   finally{input.signal.removeEventListener('abort',abort);active?.close();active=undefined;}
  },async close(){active?.close();}
 };
}
