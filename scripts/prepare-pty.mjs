// node-pty 1.1.0's macOS prebuild ships spawn-helper without an executable bit.
// Repair only the package's helper, so a fresh npm ci works without manual chmod.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chmod, stat } from 'node:fs/promises';
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const path of [
    join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
    join(root, 'build', 'Release', 'spawn-helper'),
  ]) {
    try {
      const info = await stat(path);
      await chmod(path, info.mode | 0o100);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
