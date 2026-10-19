/**
 * Real-daemon integration smoke for ContainerSession (AC02–AC05, AC07 of
 * work/container-isolation/design.md). Opt-in: needs a built runner image.
 *   AC_SMOKE_HOST=tcp://192.168.1.199:2375 AC_SMOKE_IMAGE=agent-control-dev:latest \
 *     npx tsx tests/integration/container.smoke.ts
 */
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerSession, volumeNamesFor, CACHE_VOLUME } from '../../src/runners/container.js';
import { runProc, which } from '../../src/proc.js';
import type { AppConfig } from '../../src/types.js';

const host = process.env.AC_SMOKE_HOST;
const image = process.env.AC_SMOKE_IMAGE ?? 'agent-control-dev:latest';
if (!host) {
  console.log('skip: set AC_SMOKE_HOST (and build the image, see docker/Dockerfile) to run');
  process.exit(0);
}

const agent: AppConfig['agent'] = {
  provider: 'pi',
  model: process.env.AC_SMOKE_MODEL ?? 'new-api/deepseek-v4.1-flash',
  sandbox: 'danger-full-access',
  review_sandbox: 'danger-full-access',
  env_deny: [],
  isolation: 'docker',
  container: { image, host, extra_args: [] },
};

const wt = mkdtempSync(join(tmpdir(), 'ac-smoke-wt-'));
const arts = mkdtempSync(join(tmpdir(), 'ac-smoke-ar-'));
mkdirSync(join(wt, 'sub'), { recursive: true });
mkdirSync(join(wt, 'node_modules', 'pkg'), { recursive: true });
mkdirSync(join(wt, '.git'), { recursive: true });
writeFileSync(join(wt, 'a.txt'), 'original');
writeFileSync(join(wt, 'sub', 'g.txt'), 'gone-soon');
writeFileSync(join(wt, 'node_modules', 'pkg', 'x.js'), 'untouched');
writeFileSync(join(wt, '.git', 'HEAD'), 'ref: refs/heads/main');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const dockerEnv = { ...process.env, DOCKER_HOST: agent.container!.host! };
const volumeLs = async () =>
  (await runProc({ argv: [which('docker') ?? 'docker', 'volume', 'ls', '--format', '{{.Name}}'], env: dockerEnv, timeoutMs: 30_000 }))
    .stdoutTail.split('\n').map((s) => s.trim());

try {
  const runId = `smoke${Date.now()}`;
  const session = await ContainerSession.open({ runId, worktreePath: wt, artifactsDir: arts, agent });
  check('open: volumes + syncUp + auth staging', true);

  // Auth files staged into /ac and moved into home by the entrypoint.
  const probe = await session.run(['sh', '-c',
    'echo mod >> /work/a.txt; rm /work/sub/g.txt; echo "GH_TOKEN_COUNT=$(env | grep -c "^GH_TOKEN=")"; ls /ac; test -f "$HOME/.pi/agent/models.json" && echo PI_AUTH_OK; (cd /work && git status >/dev/null 2>&1 && echo GIT_SAW_REPO || echo GIT_NO_REPO)',
  ], { timeoutMs: 60_000 });
  const out = probe.stdoutTail;
  check('container: exec + mutations', probe.exitCode === 0, `exit=${probe.exitCode}`);
  check('container: GH_TOKEN absent', out.includes('GH_TOKEN_COUNT=0'), out.split('\n').find((l) => l.includes('GH_TOKEN_COUNT')) ?? '');
  check('container: pi auth staged to home', out.includes('PI_AUTH_OK'));
  check('container: worktree is not a git repo (.git not uploaded)', out.includes('GIT_NO_REPO'));

  const lastName = 'smoke-last.txt';
  writeFileSync(join(arts, 'in.txt'), 'roundtrip');
  await session.pushFile(lastName, join(arts, 'in.txt'));
  const pulled = join(arts, 'out.txt');
  const pullOk = await session.pullArtifact(lastName, pulled);
  check('artifacts: pushFile/pullArtifact roundtrip', pullOk && readFileSync(pulled, 'utf8') === 'roundtrip');

  // pi actually reaches the model API from inside the container.
  const piRun = await session.run(['pi', '-p', '--mode', 'json', '--no-session', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--no-approve', '--tools', 'read', '--',
    `@/ac/${lastName}`], { timeoutMs: 120_000 });
  check('pi: model call from container', piRun.exitCode === 0 && piRun.stdoutTail.includes('message_end'),
    `exit=${piRun.exitCode} tail=${piRun.stdoutTail.slice(-200).replace(/\n/g, ' ')}`);

  await session.close({ syncBack: true });

  const a = readFileSync(join(wt, 'a.txt'), 'utf8');
  check('syncDown: container edit landed', a.includes('original') && a.includes('mod'), JSON.stringify(a));
  check('syncDown: container delete reconciled', !existsSync(join(wt, 'sub', 'g.txt')));
  check('syncDown: excluded dirs untouched', existsSync(join(wt, 'node_modules', 'pkg', 'x.js')) && existsSync(join(wt, '.git', 'HEAD')));

  const vols = await volumeLs();
  const names = volumeNamesFor(runId);
  check('teardown: session volumes removed', !vols.includes(names.worktree) && !vols.includes(names.artifacts),
    `leftover=${vols.filter((v) => v.startsWith('ac-')).join(',') || 'none'} (cache persists: ${vols.includes(CACHE_VOLUME)})`);
} catch (err) {
  check('smoke: no unexpected error', false, String(err).slice(0, 500));
} finally {
  rmSync(wt, { recursive: true, force: true });
  rmSync(arts, { recursive: true, force: true });
}
process.exit(failures > 0 ? 1 : 0);
