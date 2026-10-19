#!/usr/bin/env node
// project-runner manager 行为自检（agent-control 受信 check）。
// 在 worktree 根目录（cwd）运行，对 skills/project-runner/scripts/manager.mjs
// 做隔离 --home 的行为验证：UNKNOWN 未结记录默认拒启、--ack-unresolved 恢复语义。
// 通过：exit 0；失败：exit 1 并输出失败断言。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = 'PR_SELFTEST_MARK';
const NODE = process.execPath;
const MGR = path.join(process.cwd(), 'skills', 'project-runner', 'scripts', 'manager.mjs');
const fails = [];
const pids = new Set();

function sh(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
}
function mgr(...args) {
  const p = sh(NODE, [MGR, '--home', HOME, '--json', ...args]);
  let d = null;
  try { d = JSON.parse(p.stdout); } catch { /* keep null */ }
  return { rc: p.status, d, out: p.stdout, err: p.stderr };
}
function check(label, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (cond ? '' : ' || ' + detail));
  if (!cond) fails.push(label);
}
function sleeperCmdlines() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${MARK}*' } | Select-Object -ExpandProperty ProcessId`;
  const p = sh('pwsh', ['-NoProfile', '-Command', ps]);
  return (p.stdout || '').split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);
}
function killPid(pid) { if (pid) sh('taskkill', ['/F', '/PID', String(pid)]); }
function cleanup() {
  for (const pid of pids) killPid(pid);
  for (const pid of sleeperCmdlines()) killPid(pid);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
  try { fs.unlinkSync(DESC); } catch { /* ignore */ }
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-selftest-home-'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-selftest-root-'));
const DESC = path.join(HOME, 'desc.json');

try {
  if (!fs.existsSync(MGR)) {
    console.log('FAIL manager.mjs missing: ' + MGR);
    process.exit(1);
  }
  fs.writeFileSync(DESC, JSON.stringify({
    alias: 'selftest', root: ROOT, cwd: ROOT, mode: 'java',
    exe: NODE, args: ['-e', `setInterval(()=>{},1e3);/*${MARK}*/`],
  }));

  // 1) 首次受管启动
  let r = mgr('start-new', '--desc', DESC);
  check('start-new ok', r.rc === 0 && r.d && r.d.ok === true, JSON.stringify(r.d || r.out).slice(0, 300));
  if (!(r.d && r.d.data)) { throw new Error('start-new failed, cannot continue'); }
  const appId = r.d.data.appId, run1 = r.d.data.runId, pid1 = r.d.data.pid;
  pids.add(pid1);

  // 2) 模拟未结记录：phase=UNKNOWN（进程仍存活）
  const rtFile = path.join(HOME, 'runtime', appId + '.json');
  const rt = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
  rt.current.phase = 'UNKNOWN';
  fs.writeFileSync(rtFile, JSON.stringify(rt, null, 2));
  const n0 = sleeperCmdlines().length;

  // 3) 默认 start 必须拒绝，且不产生第二实例、不归档旧账
  r = mgr('start', 'selftest');
  check('UNKNOWN 默认拒绝（非零退出）', r.rc !== 0, JSON.stringify(r.d || r.out).slice(0, 300));
  const n1 = sleeperCmdlines().length;
  check('拒绝后无第二实例', n1 === n0, `before=${n0} after=${n1}`);
  const rt2 = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
  check('旧账未被归档（current 仍为 run1 且 UNKNOWN）',
    rt2.current && rt2.current.runId === run1 && rt2.current.phase === 'UNKNOWN',
    JSON.stringify(rt2.current || null).slice(0, 200));

  // 4) ack 但旧进程存活 → 仍拒绝
  r = mgr('start', 'selftest', '--ack-unresolved', run1);
  check('ack+进程存活 拒绝', r.rc !== 0, JSON.stringify(r.d || r.out).slice(0, 300));
  check('ack 拒绝后无第二实例', sleeperCmdlines().length === n0, `now=${sleeperCmdlines().length}`);

  // 5) 旧进程退出 + 正确 ack → 归档（abandoned-by-ack）并启动新实例
  killPid(pid1); pids.delete(pid1);
  await new Promise(res => setTimeout(res, 1500));
  r = mgr('start', 'selftest', '--ack-unresolved', run1);
  check('ack+进程已退出 启动成功', r.rc === 0 && r.d && r.d.data && r.d.data.abandonedRunId === run1,
    JSON.stringify(r.d || r.out).slice(0, 300));
  if (r.d && r.d.data && r.d.data.pid) pids.add(r.d.data.pid);
  const rt3 = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
  const prev0 = (rt3.prevRuns || [])[0] || {};
  check('归档证据保留（abandoned-by-ack + pid）',
    prev0.runId === run1 && prev0.archiveReason === 'abandoned-by-ack' && prev0.pid === pid1,
    JSON.stringify(prev0).slice(0, 200));

  // 6) RUNNING 语义不回退
  r = mgr('start', 'selftest');
  check('RUNNING 拒绝重复启动', r.rc !== 0, JSON.stringify(r.d || r.out).slice(0, 200));

  // 7) 停止后直启
  r = mgr('stop', 'selftest');
  check('stop ok', r.rc === 0, JSON.stringify(r.d || r.out).slice(0, 200));
  r = mgr('start', 'selftest');
  check('STOPPED 后 start ok', r.rc === 0, JSON.stringify(r.d || r.out).slice(0, 200));
  if (r.d && r.d.data && r.d.data.pid) pids.add(r.d.data.pid);
  mgr('stop', 'selftest');
} catch (e) {
  check('harness 未抛异常', false, String(e && e.stack || e).slice(0, 400));
} finally {
  cleanup();
  console.log(fails.length ? `RESULT: ${fails.length} FAILED: ${fails.join('; ')}` : 'RESULT: ALL PASS');
}
process.exit(fails.length ? 1 : 0);
