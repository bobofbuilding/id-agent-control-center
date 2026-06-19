/** End-to-end check of the chat dispatch loop against the live manager. */
import { ManagerClient } from '../api/client.ts';
import { loadConfig } from '../config.ts';

async function main() {
  const client = new ManagerClient(loadConfig());
  const agents = await client.agents();
  const target = agents.find((a) => /^(lead|manager)$/i.test(a.name))?.name ?? agents[0]?.name;
  if (!target) {
    console.error('no agents to dispatch to');
    process.exit(1);
  }
  console.log(`[dispatch-smoke] asking "${target}" a trivial question…`);
  const t0 = Date.now();
  const reply = await client.dispatch(`/ask ${target} Reply with exactly the word READY and nothing else.`, {
    onTick: (s) => console.log(`  … ${s} (${Math.round((Date.now() - t0) / 1000)}s)`),
    totalTimeoutMs: 90_000,
  });
  console.log(`[dispatch-smoke] reply from ${target}: ${JSON.stringify(reply)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[dispatch-smoke] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
