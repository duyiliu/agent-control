import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPolicyReport } from '../scripts/review-policy-report.js';
import { newReviewControl } from '../src/verify/review-policy.js';
import { makeStore, tmpDir, teardown } from './helpers.js';

test('review statistics count unique non-sandbox issue tasks and disclose legacy and renewed attempts', () => {
  const dir = tmpDir(); const store = makeStore(dir);
  try {
    const seed = (repo: string, n: number, policy = true) => {
      const t = store.upsertDiscovered({ repo, issue_number: n, issue_title: 'fixture', issue_url: 'u' }).task;
      if (policy) store.saveReviewControl(t.id, { ...newReviewControl('r'), rounds: 1 });
      return t;
    };
    const auto = seed('owner/app', 1);
    store.setTaskStatus(auto.id, 'COMPLETED', { approved_by: 'review' });
    const renewed = seed('owner/app', 2);
    store.setTaskStatus(renewed.id, 'COMPLETED', { approved_by: 'review' });
    for (let i = 0; i < 3; i++) {
      const run = store.claimRun(renewed.id);
      store.transition(run.run_id, 'CLAIMED', 'CLAIMED', { kind: 'review_requeued', budget_renewed: true });
      store.endRun(run.run_id, 'COMPLETED');
    }
    seed('owner/app', 3, false);
    seed('owner/agent-sandbox', 4);
    store.upsertPrTask({ repo: 'owner/app', number: 5, title: 'external', url: 'u', branch: 'b' });
    const r = reviewPolicyReport(store.db);
    assert.equal(r.total_v2_tasks, 2); assert.equal(r.legacy_tasks, 1); assert.equal(r.excluded_sandbox_tasks, 1);
    assert.deepEqual(r.first_automatic_closure, { tasks: 1, rate: 0.5 }); assert.equal(r.attempts.length, 2);
    assert.equal(r.attempts.find(t => t.issue_number === 2)?.budget_renewed, true);
  } finally { teardown(dir, [store]); }
});
