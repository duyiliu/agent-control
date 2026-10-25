import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckSpec } from '../types.js';

export interface CheckPlan {
  checks: CheckSpec[];
  source: 'configured' | 'package-scripts' | 'none';
  bootstrap?: boolean;
  error?: string;
}

export function resolveCheckPlan(configured: CheckSpec[], workdir: string, bootstrapSpec?: CheckSpec): CheckPlan {
  const needsDeps = !existsSync(join(workdir, 'node_modules')) && existsSync(join(workdir, 'package-lock.json'));
  if (configured.length) {
    // Configured checks in a fresh materialization still need deps installed
    // first — the early return used to skip bootstrap and a bare `npm run
    // check` could only fail with ERR_MODULE_NOT_FOUND.
    const bootstrap = !!bootstrapSpec && needsDeps;
    return { checks: bootstrap ? [bootstrapSpec, ...configured] : configured, source: 'configured', ...(bootstrap ? { bootstrap } : {}) };
  }
  const path = join(workdir, 'package.json');
  if (!existsSync(path)) return { checks: [], source: 'none' };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('invalid manifest');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, unknown> } | null;
    const scripts = manifest?.scripts;
    const has = (name: string) => !!scripts && typeof scripts[name] === 'string' && !!(scripts[name] as string).trim();
    const names = has('check') ? ['check'] : ['test', 'typecheck', has('compile') ? 'compile' : 'build'].filter(has);
    if (!names.length) return { checks: [], source: 'none' };
    const checks: CheckSpec[] = names.map(name => ({ argv: ['npm', 'run', name], timeout_seconds: 600 }));
    const bootstrap = !existsSync(join(workdir, 'node_modules')) && existsSync(join(workdir, 'package-lock.json'));
    if (bootstrap) checks.unshift({ argv: ['npm', 'ci'], timeout_seconds: 600 });
    return { checks, source: 'package-scripts', bootstrap };
  } catch {
    return { checks: [], source: 'none', error: '无法读取 package.json 检查入口，请确认文件是有效的本地 JSON 文件' };
  }
}
