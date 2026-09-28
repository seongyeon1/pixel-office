import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Run } from '../shared/contracts.js';
import { git } from './projects.js';
const exec = promisify(execFile);
export function pullRequestIntent(prompt: string): boolean | undefined {
  if (
    /(?:pr|pull\s+request|풀\s*리퀘스트).{0,15}(?:만들지|올리지|생성하지|하지\s*마|금지)|(?:do not|don't).{0,20}(?:pr\b|pull\s+request)/i.test(
      prompt,
    )
  )
    return false;
  if (
    /(?:pr\b|pull\s+request|풀\s*리퀘스트).{0,24}(?:올려|생성|만들|열어|등록|작성)|(?:create|open|raise|submit).{0,24}\b(?:pr|pull\s+request)\b/i.test(
      prompt,
    )
  )
    return true;
}
export const requestsPullRequest = (prompt: string) => pullRequestIntent(prompt) === true;
export interface DeliveryResult {
  urls: string[];
  error?: string;
}
type Target = { worktreePath: string; baseCommit: string };
export async function workingState(targets: Target[]): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const { worktreePath: cwd } of targets) {
    const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']).catch(() => '');
    const files = new Set(
      [
        ...(
          await git(cwd, ['diff', '--name-only', '-z', ...(head ? ['HEAD'] : ['--cached']), '--'])
        ).split('\0'),
        ...(await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0'),
      ].filter(Boolean),
    );
    for (const file of files) {
      const path = join(cwd, file);
      try {
        const stat = await lstat(path);
        if (stat.isDirectory()) {
          // Git reports an untracked nested repository/worktree as one directory.
          // Snapshot its Git state rather than trying to read it as a file.
          const nestedGit = await lstat(join(path, '.git')).catch((e) => {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw e;
          });
          if (nestedGit) {
            const nestedHead = await git(path, ['rev-parse', '--verify', 'HEAD']).catch(() => '');
            const nestedChanges = await workingState([{ worktreePath: path, baseCommit: '' }]);
            state[path] = createHash('sha256')
              .update(JSON.stringify([nestedHead.trim(), Object.entries(nestedChanges).sort()]))
              .digest('hex');
          } else state[path] = 'directory';
          continue;
        }
        state[path] = createHash('sha256')
          .update(stat.isSymbolicLink() ? `symlink:${await readlink(path)}` : await readFile(path))
          .digest('hex');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') state[path] = 'deleted';
        else throw e;
      }
    }
  }
  return state;
}
export async function readGithubPullRequest(cwd: string, branch: string) {
  const { stdout } = await exec('gh', ['pr', 'view', branch, '--json', 'url,state,headRefOid'], {
    cwd,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as { url: string; state: string; headRefOid: string };
}
export async function verifyPullRequests(
  run: Run,
  readPR = readGithubPullRequest,
): Promise<DeliveryResult> {
  if (!(run.pullRequestRequested ?? requestsPullRequest(run.prompt))) return { urls: [] };
  const targets = run.repos ?? [run];
  const urls: string[] = [];
  try {
    const remaining = await workingState(targets);
    if (Object.entries(remaining).some(([path, hash]) => run.initialChanges?.[path] !== hash))
      throw new Error('이번 실행에서 변경한 파일 중 커밋되지 않은 수정이 남아 있습니다.');
    for (const target of targets) {
      const cwd = target.worktreePath;
      const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
      const branch = (await git(cwd, ['branch', '--show-current'])).trim();
      let pr;
      try {
        pr = await readPR(cwd, branch);
      } catch (e) {
        // A PR-only request may start at the already-committed HEAD. Check every
        // selected repository; unchanged repositories without a PR may be skipped.
        if (head !== target.baseCommit || targets.length === 1) throw e;
        continue;
      }
      if (pr.state !== 'OPEN' || pr.headRefOid !== head || !/^https:\/\//.test(pr.url))
        throw new Error('현재 커밋에 해당하는 열린 PR을 확인할 수 없습니다.');
      urls.push(pr.url);
    }
    if (!urls.length) throw new Error('요청한 PR의 실제 생성 결과를 확인할 수 없습니다.');
    return { urls };
  } catch (e) {
    return { urls, error: `PR 생성 미완료: ${(e as Error).message}` };
  }
}
