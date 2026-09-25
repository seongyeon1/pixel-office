export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
}
export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}
export interface WorkspaceFile {
  path: string;
  text: string;
  size: number;
}
export interface TerminalInfo {
  id: string;
  root: string;
  shell: string;
  cols: number;
  rows: number;
  command?: string;
  persistent?: boolean;
  tag?: string;
}
export type TerminalMessage =
  | { type: 'ready'; data: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };
