import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isWithin } from './projects.js';
import type { WorkspaceFile, WorkspaceListing } from '../shared/workspace.js';

export const FILE_LIMIT = 256 * 1024;
const hidden = (name: string) =>
  ['.git', '.pixel', 'node_modules', '.next', 'dist', '.DS_Store'].includes(name) ||
  /^\.env(?:$|\.(?!example$|sample$))/.test(name) ||
  /\.(pem|key)$/i.test(name);

export function createWorkspaceReader(roots: () => string[]) {
  const authorize = async (root: string) => {
    if (!isAbsolute(root) || !roots().includes(root))
      throw new Error('연결된 레포 또는 앱 작업 폴더를 선택해 주세요.');
    const canonical = await realpath(root);
    if (!(await lstat(canonical)).isDirectory()) throw new Error('폴더를 찾을 수 없습니다.');
    return canonical;
  };
  const location = async (root: string, path: string) => {
    const canonical = await authorize(root);
    if (
      isAbsolute(path) ||
      path.includes('\0') ||
      path.split(/[\\/]/).some((p) => p === '..' || hidden(p))
    )
      throw new Error('이 경로는 코드 탐색기에서 열 수 없습니다.');
    const target = resolve(canonical, path);
    if (!isWithin(canonical, target)) throw new Error('레포 외부 경로는 열 수 없습니다.');
    let cursor = canonical;
    for (const part of path.split('/').filter(Boolean)) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('심볼릭 링크는 열 수 없습니다.');
    }
    if (!isWithin(canonical, await realpath(target)))
      throw new Error('레포 외부 경로는 열 수 없습니다.');
    return target;
  };
  return {
    authorize,
    async list(root: string, path = ''): Promise<WorkspaceListing> {
      const entries = (await readdir(await location(root, path), { withFileTypes: true }))
        .filter((e) => !hidden(e.name) && (e.isFile() || e.isDirectory()))
        .sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
        );
      return {
        path,
        truncated: entries.length > 500,
        entries: entries.slice(0, 500).map((e) => ({
          name: e.name,
          path: path ? `${path}/${e.name}` : e.name,
          kind: e.isDirectory() ? 'directory' : 'file',
        })),
      };
    },
    async read(root: string, path: string): Promise<WorkspaceFile> {
      const target = await location(root, path);
      // O_NONBLOCK also prevents hanging if a file is replaced with a FIFO.
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('일반 텍스트 파일을 선택해 주세요.');
        if (stat.size > FILE_LIMIT) throw new Error('256 KB 이하의 파일만 미리 볼 수 있습니다.');
        const data = Buffer.alloc(FILE_LIMIT + 1);
        const { bytesRead } = await handle.read(data, 0, data.length, 0);
        if (bytesRead > FILE_LIMIT) throw new Error('256 KB 이하의 파일만 미리 볼 수 있습니다.');
        const bytes = data.subarray(0, bytesRead);
        if (bytes.includes(0)) throw new Error('바이너리 파일은 미리 볼 수 없습니다.');
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new Error('UTF-8 텍스트 파일만 미리 볼 수 있습니다.');
        }
        return { path, text, size: bytesRead };
      } finally {
        await handle.close();
      }
    },
  };
}
