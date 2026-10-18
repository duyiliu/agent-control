#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createApp, runDoctor, startService } from './app.js';
import { GitHubTracker, approvalHash } from './tracker/github.js';
import { Store } from './store/sqlite.js';
import type { AppConfig, Phase } from './types.js';
import { RUN_ACTIVE_PHASES } from './types.js';

const USAGE = `agent-control — personal AI dev-task scheduler

Usage:
  agent-control [--config <path>] doctor
  agent-control [--config <path>] start
  agent-control [--config <path>] status
  agent-control [--config <path>] runs <issue-number> [--repo owner/name]
  agent-control [--config <path>] retry <issue-number> [--repo owner/name]
  agent-control [--config <path>] stop  <issue-number> [--repo owner/name]

Config resolution: --config > AGENT_CONTROL_CONFIG > ./agent-control.yaml > ./config.yaml
`;

function resolveConfigPath(flag?: string): string | null {
  if (flag) return resolve(flag);
  if (process.env.AGENT_CONTROL_CONFIG) return resolve(process.env.AGENT_CONTROL_CONFIG);
  for (const name of ['agent-control.yaml', 'config.yaml']) {
    if (existsSync(name)) return resolve(name);
  }
  return null;
}

function pickRepo(config: AppConfig, flag?: string): string {
  if (flag) return flag;
  if (config.projects.length === 1) return config.projects[0]!.repo;
  throw new Error('multiple projects configured; pass --repo owner/name');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: 'string' }, repo: { type: 'string' } },
  });
  const cmd = positionals[0];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return;
  }

  const configPath = resolveConfigPath(values.config);
  let config: AppConfig | null = null;
  let configError: string | undefined;
  if (configPath) {
    try {
      config = loadConfig(configPath);
    } catch (err) {
      configError = String(err);
    }
  } else {
    configError = 'no config file found';
  }

  switch (cmd) {
    case 'doctor': {
      const items = await runDoctor(config, configError ? `${configError}${configPath ? ` (${configPath})` : ''}` : undefined);
      let fail = 0;
      for (const i of items) {
        console.log(`${i.status.padEnd(10)} ${i.name.padEnd(28)} ${i.detail}`);
        if (i.status === 'FAIL') fail++;
      }
      process.exitCode = fail > 0 ? 1 : 0;
      return;
    }

    case 'start': {
      if (!config) die(`config required: ${configError}`);
      const app = createApp(config);
      console.log(`agent-control starting; db=${config.server.database} poll=${config.server.poll_interval_seconds}s`);
      await startService(app);
      return; // startService never returns until shutdown
    }

    case 'status': {
      if (!config) die(`config required: ${configError}`);
      const store = new Store(config.server.database);
      try {
        const tasks = store.listTasks();
        if (tasks.length === 0) { console.log('(no tasks)'); return; }
        for (const t of tasks) {
          const runs = store.runsForTask(t.id);
          const last = runs[runs.length - 1];
          const dur = last ? `attempt=${last.attempt} phase=${last.phase}` : 'no runs';
          console.log(`#${t.issue_number}\t${t.status}\t${t.repo}\t${dur}\t${t.pr_url ?? ''}\t${t.issue_title}`);
        }
        const lastErr = store.getMeta('last_error');
        if (lastErr) {
          try {
            const e = JSON.parse(lastErr) as { at: string; kind: string; error: string };
            console.log(`\nlast internal error: ${e.at} ${e.kind}: ${e.error}`);
          } catch {
            console.log(`\nlast internal error: ${lastErr}`);
          }
        }
      } finally {
        store.close();
      }
      return;
    }

    case 'runs': {
      if (!config) die(`config required: ${configError}`);
      const issueNumber = Number(positionals[1]);
      if (!Number.isInteger(issueNumber)) die('runs <issue-number> required');
      const repo = pickRepo(config, values.repo);
      const store = new Store(config.server.database);
      try {
        const task = store.getTask(repo, issueNumber);
        if (!task) die(`no task for ${repo}#${issueNumber}`);
        console.log(`task ${repo}#${issue_number_pad(issueNumber)} status=${task.status} hash=${task.approved_hash?.slice(0, 12) ?? '-'}`);
        for (const r of store.runsForTask(task.id)) {
          console.log(`\nrun ${r.run_id} attempt=${r.attempt} phase=${r.phase} started=${r.started_at} ended=${r.ended_at ?? '-'} reason=${r.reason ?? '-'}`);
          for (const e of store.eventsForRun(r.run_id)) {
            console.log(`  ${e.at}  ${e.from_phase ?? '-'} -> ${e.to_phase}  ${e.detail_json ?? ''}`);
          }
          for (const c of store.checksForRun(r.run_id)) {
            console.log(`  check ${c.kind}: ${c.command} → ${c.verdict} (exit ${c.exit_code ?? 'n/a'}) ${c.artifact_path ?? ''}`);
          }
        }
      } finally {
        store.close();
      }
      return;
    }

    case 'retry': {
      if (!config) die(`config required: ${configError}`);
      const issueNumber = Number(positionals[1]);
      if (!Number.isInteger(issueNumber)) die('retry <issue-number> required');
      const repo = pickRepo(config, values.repo);
      const store = new Store(config.server.database);
      try {
        const task = store.getTask(repo, issueNumber);
        if (!task) die(`no task for ${repo}#${issueNumber}`);
        const retryable: Phase[] = ['BLOCKED', 'BLOCKED_APPROVAL_CHANGED', 'RECOVERY_REQUIRED', 'CANCELED', 'FAILED'];
        if (!retryable.includes(task.status)) die(`task status ${task.status} is not retryable`);
        if (store.activeRunForTask(task.id)) die('an active run still exists; stop it first');

        // Re-validate approval against the CURRENT issue content — a human
        // retry means "the current issue text is what I approve".
        const project = config.projects.find((p) => p.repo === repo);
        if (!project) die(`project ${repo} not in config`);
        const tracker = new GitHubTracker();
        const issue = await tracker.getIssue(repo, issueNumber);
        if (!issue || issue.state !== 'OPEN') die('issue is closed or missing');
        if (!issue.labels.includes(project.ready_label)) die(`issue lacks ${project.ready_label} label`);

        store.setTaskStatus(task.id, 'DISCOVERED', { approved_hash: approvalHash(issue) });
        await tracker.removeLabel(repo, issueNumber, 'agent-blocked').catch(() => {});
        console.log(`task ${repo}#${issueNumber} re-queued (hash ${approvalHash(issue).slice(0, 12)})`);
      } finally {
        store.close();
      }
      return;
    }

    case 'stop': {
      if (!config) die(`config required: ${configError}`);
      const issueNumber = Number(positionals[1]);
      if (!Number.isInteger(issueNumber)) die('stop <issue-number> required');
      const repo = pickRepo(config, values.repo);
      const store = new Store(config.server.database);
      try {
        const task = store.getTask(repo, issueNumber);
        if (!task) die(`no task for ${repo}#${issueNumber}`);
        const run = store.activeRunForTask(task.id);
        if (run) {
          store.requestCancel(run.run_id);
          console.log(`cancel requested for run ${run.run_id}; the scheduler aborts it within one poll cycle`);
        } else if ((RUN_ACTIVE_PHASES as readonly Phase[]).includes(task.status)) {
          store.setTaskStatus(task.id, 'CANCELED');
          console.log(`task ${repo}#${issueNumber} cancelled`);
        } else {
          console.log(`task ${repo}#${issueNumber} has no active run (status=${task.status})`);
        }
      } finally {
        store.close();
      }
      return;
    }

    default:
      die(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

function issue_number_pad(n: number): string {
  return String(n);
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

main().catch((err) => die(String(err?.stack ?? err)));
