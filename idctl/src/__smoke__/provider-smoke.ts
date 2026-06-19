/** Probe local/cloud backends via ProviderClient. Verifies discovery shapes. */
import { ProviderClient } from '../settings/ProviderClient.ts';
import { defaultBaseUrl, type ProviderProfile } from '../settings/schema.ts';

function prof(name: string, kind: ProviderProfile['kind']): ProviderProfile {
  return { name, kind, baseUrl: defaultBaseUrl(kind), enabled: true };
}

async function main() {
  const cases: ProviderProfile[] = [
    prof('local-ollama', 'ollama'),
    prof('lmstudio', 'lmstudio'), // expected unreachable if not running — that's a pass for graceful handling
  ];
  let bad = 0;
  for (const p of cases) {
    const out = await new ProviderClient(p, undefined).probe();
    const head = out.models.slice(0, 5).map((m) => `${m.id}${m.detail ? ` (${m.detail})` : ''}`).join(', ');
    console.log(`[${p.kind}] ${p.baseUrl}\n  status=${out.status} httpStatus=${out.httpStatus ?? '-'} models=${out.models.length}` + (head ? `\n  → ${head}` : '') + (out.message ? `\n  msg: ${out.message}` : ''));
    // Pass criteria: ollama must be live with >=1 model; others just must not throw.
    if (p.kind === 'ollama' && !(out.status === 'live' && out.models.length > 0)) bad++;
  }
  console.log(`\n[provider-smoke] ${bad === 0 ? 'OK' : 'FAIL'}`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[provider-smoke] threw:', e);
  process.exit(2);
});
