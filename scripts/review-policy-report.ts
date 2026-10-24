import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseReviewControl } from '../src/verify/review-policy.js';

export function reviewPolicyReport(db: DatabaseSync) {
  const tasks = db.prepare("SELECT * FROM tasks WHERE source = 'issue' ORDER BY id").all();
  const events = db.prepare('SELECT r.task_id, e.detail_json FROM run_events e JOIN runs r ON r.run_id=e.run_id ORDER BY e.id').all();
  const renewed = new Set(events.filter(e => {
    const detail = JSON.parse(String(e.detail_json ?? '{}')) ?? {};
    return detail.budget_renewed || detail.kind === 'review_budget_renewed';
  }).map(e => e.task_id));
  const decisions = new Set(events.filter(e => (JSON.parse(String(e.detail_json ?? '{}'))?.decisions ?? 0) > 0).map(e => e.task_id));
  const priorAttempts = (id: unknown, key: string) => events.filter(e => e.task_id === id).reduce((sum, e) => {
    const detail = JSON.parse(String(e.detail_json ?? '{}'));
    return sum + (detail && (detail.budget_renewed || detail.kind === 'review_budget_renewed') ? Number(detail[key] ?? 0) : 0);
  }, 0);
  const included = tasks.filter(t => !/sandbox/i.test(String(t.repo)));
  const samples = included.flatMap(task => {
    const control = parseReviewControl(task.review_control_json);
    return control ? [{ task, control }] : [];
  });
  const total = samples.length;
  const rate = (count: number) => ({ tasks: count, rate: total ? count / total : null });
  return {
    definition: '按非 sandbox 的 issue 任务去重；分母含进行中 v2 任务。首次自动闭合要求自动批准合并、仅一轮评审、无修复/故障/续期/人工回答；执行受阻取当前终止故障状态。历史 legacy 不混入 v2。',
    total_v2_tasks: total,
    excluded_sandbox_tasks: tasks.length - included.length,
    legacy_tasks: included.length - total,
    first_automatic_closure: rate(samples.filter(({ task, control: c }) => task.status === 'COMPLETED' && task.approved_by === 'review'
      && c.rounds === 1 && c.fix_attempts === 0 && c.infra_attempts === 0 && c.decisions.length === 0 && c.resolutions.length === 0 && !renewed.has(task.id) && !decisions.has(task.id)).length),
    human_decision: rate(samples.filter(({ task, control: c }) => decisions.has(task.id) || c.decisions.length > 0 || c.resolutions.length > 0).length),
    execution_blocked: rate(samples.filter(({ task, control: c }) => ['BLOCKED', 'FAILED', 'RECOVERY_REQUIRED'].includes(String(task.status))
      && !c.resolutions.some(r => r.head_sha === c.head_sha && r.requirement_hash === c.requirement_hash && r.selected_option === '拒绝当前提交')).length),
    attempts: samples.map(({ task, control: c }) => ({ repo: task.repo, issue_number: task.issue_number,
      rounds: c.rounds + priorAttempts(task.id, 'previous_rounds'), current_budget_rounds: c.rounds,
      infrastructure_failures: c.infra_attempts + priorAttempts(task.id, 'previous_infra_attempts'),
      fixes: c.fix_attempts + priorAttempts(task.id, 'previous_fix_attempts'), budget_renewed: renewed.has(task.id) })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) throw new Error('用法：npx tsx scripts/review-policy-report.ts <数据库路径>');
  const db = new DatabaseSync(resolve(file), { readOnly: true });
  try { console.log(JSON.stringify(reviewPolicyReport(db), null, 2)); }
  finally { db.close(); }
}
