import assert from 'node:assert/strict';
import { findProvider, providerNeedsKey } from './providerCatalog.ts';
import { resolveProviderKey } from './store.ts';

const nvidia = findProvider('nvidia');
assert.ok(nvidia, 'NVIDIA provider catalog entry should exist');
assert.equal(nvidia.name, 'NVIDIA API Catalog');
assert.equal(nvidia.baseUrl, 'https://integrate.api.nvidia.com/v1');
assert.equal(nvidia.needsKey, true);
assert.deepEqual(nvidia.models, [
  'minimaxai/minimax-m3',
  'qwen/qwen3.5-397b-a17b',
  'moonshotai/kimi-k2.6',
  'zhipuai/glm-5.1',
  'deepseek/deepseek-v4-flash',
]);

assert.equal(
  providerNeedsKey({ name: 'nvidia', kind: 'openai-compatible', baseUrl: nvidia.baseUrl }),
  true,
  'NVIDIA should remain key-required even though it is OpenAI-compatible',
);
assert.equal(
  providerNeedsKey({ name: 'openrouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' }),
  true,
  'catalog-matched cloud OpenAI-compatible providers should require keys',
);
assert.equal(
  providerNeedsKey({ name: 'local-vllm', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1' }),
  false,
  'custom local OpenAI-compatible providers should remain keyless by default',
);

const oldPerplexityKey = process.env.PERPLEXITY_API_KEY;
process.env.PERPLEXITY_API_KEY = 'pplx-test-key';
assert.equal(
  resolveProviderKey({ name: 'perplexity', kind: 'openai-compatible', baseUrl: 'https://api.perplexity.ai', enabled: true }),
  'pplx-test-key',
  'Perplexity should resolve the official PERPLEXITY_API_KEY env var',
);
if (oldPerplexityKey == null) delete process.env.PERPLEXITY_API_KEY;
else process.env.PERPLEXITY_API_KEY = oldPerplexityKey;

console.log('[providerCatalog.test] OK');
