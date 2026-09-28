export interface WorktreeCleanupEntry {
  path: string;
  repository: string;
  branch: string;
  prompt: string;
  runIds: string[];
  changedFiles: number;
  changes: string[];
  blockedReason?: string;
}
