import assert from 'node:assert/strict';
import { LOCAL_DISCOVERY_CANDIDATES, mergeLocalDiscoveryCandidates } from './localDiscovery.ts';

const merged = mergeLocalDiscoveryCandidates([
  {
    id: 'tgi-alt',
    name: 'Hugging Face TGI alternate',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:8081/v1',
    port: 8081,
  },
  {
    id: 'remote-bad',
    name: 'Remote bad',
    kind: 'openai-compatible',
    baseUrl: 'http://example.com:8081/v1',
    port: 8081,
  },
  {
    id: 'kind-bad',
    name: 'Kind bad',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:8082/v1',
    port: 8082,
  },
]);

assert.ok(
  merged.some((c) => c.id === 'tgi-alt' && c.baseUrl === 'http://127.0.0.1:8081/v1' && c.port === 8081),
  'loopback alternate-port candidates should be accepted and normalized',
);
assert.equal(
  merged.some((c) => c.id === 'remote-bad'),
  false,
  'extra discovery candidates must stay on loopback',
);
assert.equal(
  merged.some((c) => c.id === 'kind-bad'),
  false,
  'extra discovery candidates must use local provider kinds',
);
assert.equal(
  mergeLocalDiscoveryCandidates([{ ...LOCAL_DISCOVERY_CANDIDATES[0] }]).length,
  LOCAL_DISCOVERY_CANDIDATES.length,
  'extra discovery candidates should dedupe built-in endpoints',
);

console.log('[localDiscovery.test] OK');
