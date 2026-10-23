// Child fixture: a real startService on a temp store with a fake engine whose
// first tick hangs on a gate. The test asserts SIGTERM reaches engine.shutdown
// (not abortRun), the service waits for it, then releases the lock.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startService, InstanceLock } from '../../src/app.js';
import { Store } from '../../src/store/sqlite.js';
import { makeConfig } from '../helpers.js';

// Parent passes the fixture's temp dir (.tmp) as argv[2].
const dir = process.argv[2]!;
mkdirSync(dir, { recursive: true });
const config = makeConfig(dir);
config.server.ui.enabled = false;
const store = new Store(config.server.database);
let tickGate: (() => void) | null = null;
const tickEntered = new Promise<void>((r) => { (globalThis as Record<string, unknown>).__mark = r; });
const calls: string[] = [];
const engine = {
  calls,
  async tick() {
    calls.push('tick');
    (globalThis as Record<string, (() => void) | undefined>).__mark?.();
    await new Promise<void>((r) => { tickGate = r; });
  },
  async shutdown(_ms: number) {
    calls.push('shutdown');
    await new Promise((r) => setTimeout(r, 30));
    // startService proceeds to lock.release/process.exit after this resolves —
    // emit the verdict here, the parent only needs the call record.
    console.log('RESULT ' + JSON.stringify({ calls }));
    return true;
  },
  abortRun() { calls.push('abortRun'); },
  sweepCancels() {},
  resumeRun() { return true; },
  activeCount() { return 0; },
};
const tracker = new Proxy({}, { get: () => async () => [] });
const app = {
  config, store,
  engine: engine as never,
  lock: new InstanceLock(config.server.database),
  tracker: tracker as never,
};
void startService(app);
await tickEntered;
process.emit('SIGTERM' as never);
await new Promise((r) => setTimeout(r, 20));
tickGate?.();
await new Promise((r) => setTimeout(r, 200));
console.log('AFTER ' + JSON.stringify({ calls }));
