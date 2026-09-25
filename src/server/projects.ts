import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, mkdir, lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, dirname } from 'node:path';
import type { Change } from '../shared/contracts.js';
const exec = promisify(execFile);
export const git = async (cwd:string,args:string[]) => (await exec('git',args,{cwd,maxBuffer:8*1024*1024,timeout:20000})).stdout;
export async function inspectProject(path:string) {
 if(!isAbsolute(path))throw new Error('프로젝트의 절대 경로를 입력해 주세요.');
 const canonical=await realpath(path);let root:string;
 try{root=(await git(canonical,['rev-parse','--show-toplevel'])).trim();}catch{throw new Error('Git 저장소를 선택해 주세요.');}
 let head:string;try{head=(await git(root,['rev-parse','--verify','HEAD'])).trim();}catch{throw new Error('최초 커밋이 필요합니다. 프로젝트에서 git add와 git commit을 실행해 주세요.');}
 return {root:await realpath(root),head,dirty:!!(await git(root,['status','--porcelain'])).trim()};
}
export async function createWorkspace(projectPath:string,runId:string,dataDir:string){
 if(!/^[a-zA-Z0-9-]+$/.test(runId))throw new Error('잘못된 실행 ID');
 const project=await inspectProject(projectPath);const path=join(dataDir,'workspaces',runId);await mkdir(dirname(path),{recursive:true});
 const branch=`pixel/${runId}`;await git(project.root,['worktree','add','-b',branch,path,project.head]);return {path,branch,baseCommit:project.head};
}
export async function collectChanges(cwd:string,baseCommit:string):Promise<Change[]>{
 const tracked=(await git(cwd,['diff','--name-only','-z',baseCommit,'--'])).split('\0').filter(Boolean);
 const untracked=(await git(cwd,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
 const results:Change[]=[];const max=256*1024;
 for(const path of [...new Set([...tracked,...untracked])].slice(0,200)){
  let diff='',truncated=false;const full=join(cwd,path);const status=untracked.includes(path)?'added':'modified';
  try{
   const stat=await lstat(full);
   if(stat.isSymbolicLink()){diff='심볼릭 링크 (대상 파일을 읽지 않음)';}
   else if(!stat.isFile()){diff='일반 파일이 아닙니다.';}
   else if(stat.size>max){diff=`큰 파일 (${stat.size.toLocaleString()} bytes). 작업 폴더에서 확인해 주세요.`;truncated=true;}
   else if(!isWithin(cwd,await realpath(full))){diff='작업 폴더 외부 파일은 표시하지 않습니다.';}
   else {
    const data=await readFile(full);
    if(data.includes(0))diff='바이너리 파일';
    else if(status==='added')diff=data.toString('utf8').split('\n').map(l=>'+'+l).join('\n');
    else diff=await git(cwd,['diff','--no-ext-diff','--no-textconv',baseCommit,'--',path]);
   }
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')diff=await git(cwd,['diff','--no-ext-diff','--no-textconv',baseCommit,'--',path]);else throw e;}
  if(diff.length>max){diff=diff.slice(0,max);truncated=true;}results.push({path,status,diff,truncated});
 }
 return results;
}
export function isWithin(root:string,target:string){const rel=relative(root,target);return rel===''||(!rel.startsWith('..'+ '/')&&rel!=='..'&&!isAbsolute(rel));}
