/**
 * Curated catalog of Ollama-pullable local models for the "Local Models" card —
 * a browsable library (filter by capability / size) on top of the raw `ollama
 * pull` mechanism, so the operator doesn't have to memorize tags.
 *
 * Each `id` is an exact `ollama pull <id>` tag. Sizes are the approximate
 * download size of the default quant; contextTokens is the model's native max
 * context window. Web-verified against ollama.com/library
 * (local-stacks-and-models-catalog + model-context-enrichment research).
 */

export type ModelCapability =
  | 'general' | 'tools' | 'reasoning' | 'coding' | 'vision' | 'embedding' | 'multilingual' | 'fast' | 'long-context';

export interface LocalModelEntry {
  /** Exact `ollama pull` tag, e.g. 'qwen3:4b'. */
  id: string;
  /** Family label, e.g. 'Qwen3'. */
  family: string;
  /** Parameter count label, e.g. '4B'. */
  params: string;
  /** Approx default-quant download size, in GB. */
  approxSizeGB?: number;
  /** Native max context window, in tokens. */
  contextTokens?: number;
  /** Human label for the context window, e.g. '128K'. */
  contextLabel?: string;
  blurb?: string;
  capabilities: ModelCapability[];
  /** License (e.g. 'Apache 2.0', 'MIT', 'Llama 3.2 Community License'). */
  license?: string;
  /** A good default pick in its size class. */
  recommended?: boolean;
}

/** Web-verified Ollama-pullable models, ordered small→large within families. */
export const LOCAL_MODEL_CATALOG: LocalModelEntry[] = [
  {"id": "qwen3:1.7b", "family": "Qwen3", "params": "1.7B", "approxSizeGB": 1.4, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["general", "tools", "reasoning", "fast", "multilingual", "long-context"], "license": "Apache 2.0", "recommended": true, "blurb": "Best sub-2B daily driver: thinking mode, solid tool use, multilingual, runs anywhere."},
  {"id": "qwen3:4b", "family": "Qwen3", "params": "4B", "approxSizeGB": 2.5, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["general", "tools", "reasoning", "coding", "multilingual", "long-context"], "license": "Apache 2.0", "recommended": true, "blurb": "Outstanding mid-size pick — reasoning, coding and agentic tool calling that rivals older 7-8B models."},
  {"id": "qwen3:8b", "family": "Qwen3", "params": "8B", "approxSizeGB": 5.2, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["general", "tools", "reasoning", "coding", "multilingual", "long-context"], "license": "Apache 2.0", "recommended": true, "blurb": "Strongest 8B all-rounder: hybrid reasoning, robust tool use, great coding and multilingual breadth."},
  {"id": "qwen3:14b", "family": "Qwen3", "params": "14B", "approxSizeGB": 9.3, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["general", "reasoning", "tools", "coding", "long-context"], "license": "Apache 2.0", "recommended": true, "blurb": "Modern hybrid-thinking generalist with strong tool use; great default in the 14B class."},
  {"id": "qwen3:30b-a3b", "family": "Qwen3", "params": "30B (MoE, 3B active)", "approxSizeGB": 19, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["general", "reasoning", "tools", "fast", "long-context"], "license": "Apache 2.0", "recommended": true, "blurb": "MoE with only 3B active params: 30B-class quality at near-small-model speed; excellent local agent backbone."},
  {"id": "qwen3:32b", "family": "Qwen3", "params": "32B", "approxSizeGB": 20, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["general", "reasoning", "tools", "long-context"], "license": "Apache 2.0", "blurb": "Dense 32B; strongest single-pass quality in the family, heavier than the 30B MoE."},
  {"id": "qwen3:0.6b", "family": "Qwen3", "params": "0.6B", "approxSizeGB": 0.523, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["general", "tools", "reasoning", "fast", "multilingual", "long-context"], "license": "Apache 2.0", "blurb": "Tiny Qwen3 with hybrid thinking and tool-calling; remarkably capable for its size but use 1.7b+ for real work."},
  {"id": "llama3.2:3b", "family": "Llama 3.2", "params": "3B", "approxSizeGB": 2, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "tools", "fast", "multilingual", "long-context"], "license": "Llama 3.2 Community License", "recommended": true, "blurb": "Excellent lightweight default: clean instruction-following, tool calling and 128K context at 2GB."},
  {"id": "llama3.1:8b", "family": "Llama 3.1", "params": "8B", "approxSizeGB": 4.9, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "tools", "coding", "multilingual", "long-context"], "license": "Llama 3.1 Community License", "recommended": true, "blurb": "Proven, well-supported 8B workhorse with 128K context and reliable tool use; the safe ecosystem default."},
  {"id": "llama3.2:1b", "family": "Llama 3.2", "params": "1B", "approxSizeGB": 1.3, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "tools", "fast", "multilingual", "long-context"], "license": "Llama 3.2 Community License", "blurb": "Featherweight Meta model with 128K context; fine for summarization/classification, edged out by qwen3:1.7b."},
  {"id": "gemma3:4b", "family": "Gemma 3", "params": "4B", "approxSizeGB": 3.3, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "vision", "multilingual", "long-context"], "license": "Gemma Terms of Use", "recommended": true, "blurb": "Best small multimodal pick: native image input, 128K context and strong multilingual quality at 4B."},
  {"id": "gemma3:12b", "family": "Gemma 3", "params": "12B", "approxSizeGB": 8.1, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "vision", "multilingual", "long-context"], "license": "Gemma Terms of Use", "recommended": true, "blurb": "Multimodal Google generalist; text+image input, broad multilingual coverage, 128K context."},
  {"id": "gemma3:27b", "family": "Gemma 3", "params": "27B", "approxSizeGB": 17, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "vision", "multilingual", "long-context"], "license": "Gemma Terms of Use", "recommended": true, "blurb": "Largest single-GPU Gemma 3; top open multimodal generalist around 24GB VRAM."},
  {"id": "gemma3:1b", "family": "Gemma 3", "params": "1B", "approxSizeGB": 0.815, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["general", "fast", "multilingual"], "license": "Gemma Terms of Use", "blurb": "Compact Google text model; quick and capable but no tool calling and short-ish context vs Qwen3."},
  {"id": "phi4-mini:3.8b", "family": "Phi-4-mini", "params": "3.8B", "approxSizeGB": 2.5, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "tools", "reasoning", "coding", "multilingual", "long-context"], "license": "MIT", "recommended": true, "blurb": "Microsoft's reasoning/math-strong small model with function calling, 128K context and MIT license."},
  {"id": "qwen2.5-coder:7b", "family": "Qwen2.5-Coder", "params": "7B", "approxSizeGB": 4.7, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["coding", "tools"], "license": "Apache 2.0", "recommended": true, "blurb": "Excellent code model for its size; strong fill-in-the-middle and instruction following on one GPU."},
  {"id": "qwen2.5-coder:14b", "family": "Qwen2.5-Coder", "params": "14B", "approxSizeGB": 9, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["coding", "tools"], "license": "Apache 2.0", "blurb": "Mid-size coder; better multi-file reasoning than 7B."},
  {"id": "qwen2.5-coder:32b", "family": "Qwen2.5-Coder", "params": "32B", "approxSizeGB": 20, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["coding", "tools"], "license": "Apache 2.0", "recommended": true, "blurb": "Best open local coding model; rivals proprietary assistants, needs 24GB+ VRAM."},
  {"id": "qwen2.5-coder:1.5b", "family": "Qwen2.5-Coder", "params": "1.5B", "approxSizeGB": 0.99, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["coding", "fast"], "license": "Apache 2.0", "blurb": "Tiny coder for autocomplete/FIM on low-end hardware."},
  {"id": "deepseek-coder-v2:16b", "family": "DeepSeek-Coder-V2", "params": "16B (MoE, ~2.4B active)", "approxSizeGB": 8.9, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["coding", "fast", "long-context"], "license": "DeepSeek License", "recommended": true, "blurb": "Lite MoE coder; runs like a small model but codes like a larger one, 128K+ context."},
  {"id": "deepseek-r1:8b", "family": "DeepSeek-R1", "params": "8B", "approxSizeGB": 5.2, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["reasoning", "general"], "license": "MIT", "recommended": true, "blurb": "Llama-distilled R1; best balance of reasoning quality and footprint for a single consumer GPU."},
  {"id": "deepseek-r1:32b", "family": "DeepSeek-R1", "params": "32B", "approxSizeGB": 20, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["reasoning", "general"], "license": "MIT", "recommended": true, "blurb": "Top local R1 distill; near-frontier reasoning, wants 24GB+ VRAM."},
  {"id": "deepseek-r1:14b", "family": "DeepSeek-R1", "params": "14B", "approxSizeGB": 9, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["reasoning", "general"], "license": "MIT", "blurb": "Stronger reasoning distill; noticeably better on math/logic than 7-8B, fits in ~12GB VRAM."},
  {"id": "deepseek-r1:7b", "family": "DeepSeek-R1", "params": "7B", "approxSizeGB": 4.7, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["reasoning", "general"], "license": "MIT", "blurb": "Qwen-distilled R1; solid step-by-step reasoning at a mainstream size."},
  {"id": "deepseek-r1:1.5b", "family": "DeepSeek-R1", "params": "1.5B", "approxSizeGB": 1.1, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["reasoning", "fast"], "license": "MIT", "blurb": "Smallest R1 distill (Qwen base); chain-of-thought reasoning that runs on almost anything, but limited depth."},
  {"id": "mistral-nemo:12b", "family": "Mistral-Nemo", "params": "12B", "approxSizeGB": 7.1, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "tools", "multilingual", "long-context"], "license": "Apache 2.0", "recommended": true, "blurb": "Mistral+NVIDIA 12B with very long context and strong multilingual/function-calling; easy single-GPU fit."},
  {"id": "mistral:7b", "family": "Mistral", "params": "7B", "approxSizeGB": 4.4, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["general", "tools", "coding", "fast"], "license": "Apache 2.0", "blurb": "Fast, permissively-licensed classic 7B; still handy but newer Qwen3/Llama 3.1 surpass it on reasoning."},
  {"id": "mixtral:8x7b", "family": "Mixtral", "params": "8x7B (MoE, ~12.9B active)", "approxSizeGB": 26, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["general", "tools"], "license": "Apache 2.0", "blurb": "Classic sparse-MoE generalist; fast inference for its quality but needs RAM/VRAM to hold all experts."},
  {"id": "mixtral:8x22b", "family": "Mixtral", "params": "8x22B (MoE, ~39B active)", "approxSizeGB": 80, "contextTokens": 65536, "contextLabel": "64K", "capabilities": ["general", "tools", "long-context"], "license": "Apache 2.0", "blurb": "Large MoE; high quality but workstation/multi-GPU class only."},
  {"id": "granite3.3:2b", "family": "Granite 3.3", "params": "2B", "approxSizeGB": 1.5, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "tools", "reasoning", "coding", "long-context"], "license": "Apache 2.0", "blurb": "IBM enterprise-tuned small model: tool calling, 128K context and strong instruction-following at 2B."},
  {"id": "granite3.3:8b", "family": "Granite 3.3", "params": "8B", "approxSizeGB": 4.9, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "tools", "reasoning", "coding", "long-context"], "license": "Apache 2.0", "blurb": "Solid business-oriented 8B with tool use and 128K context; good RAG/agent option, Apache-licensed."},
  {"id": "qwen2.5:7b", "family": "Qwen2.5", "params": "7B", "approxSizeGB": 4.7, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "tools", "coding", "multilingual", "long-context"], "license": "Apache 2.0", "blurb": "Excellent, battle-tested 7B with great coding and tools; Apache-licensed, now edged out by qwen3:8b."},
  {"id": "qwen2.5:3b", "family": "Qwen2.5", "params": "3B", "approxSizeGB": 1.9, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "tools", "coding", "multilingual", "long-context"], "license": "Qwen Research License", "blurb": "Strong prior-gen 3B; note the 3B carries the non-commercial Qwen Research license — prefer qwen3:4b."},
  {"id": "phi3.5:3.8b", "family": "Phi-3.5", "params": "3.8B", "approxSizeGB": 2.2, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["general", "reasoning", "multilingual", "long-context"], "license": "MIT", "blurb": "Previous-gen Phi-3.5-mini; good reasoning and 128K context but superseded by phi4-mini."},
  {"id": "qwen2.5vl:7b", "family": "Qwen2.5-VL", "params": "7B", "approxSizeGB": 6, "contextTokens": 128000, "contextLabel": "125K", "capabilities": ["vision", "general", "tools"], "license": "Apache 2.0", "recommended": true, "blurb": "Strong open VLM; document/chart/OCR and grounding are excellent for the size."},
  {"id": "qwen2.5vl:32b", "family": "Qwen2.5-VL", "params": "32B", "approxSizeGB": 21, "contextTokens": 128000, "contextLabel": "125K", "capabilities": ["vision", "general", "tools"], "license": "Apache 2.0", "blurb": "Larger Qwen VLM; best local vision quality short of 72B, ~24GB VRAM."},
  {"id": "qwen2.5vl:72b", "family": "Qwen2.5-VL", "params": "72B", "approxSizeGB": 49, "contextTokens": 128000, "contextLabel": "125K", "capabilities": ["vision", "general", "tools"], "license": "Qwen License", "blurb": "Flagship Qwen vision model; multi-GPU, frontier-class document and image understanding."},
  {"id": "llama3.2-vision:11b", "family": "Llama 3.2 Vision", "params": "11B", "approxSizeGB": 7.8, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["vision", "general", "long-context"], "license": "Llama 3.2 Community License", "recommended": true, "blurb": "Meta multimodal model; solid image understanding + chat on a single GPU, 128K context."},
  {"id": "llama3.2-vision:90b", "family": "Llama 3.2 Vision", "params": "90B", "approxSizeGB": 55, "contextTokens": 131072, "contextLabel": "128K", "capabilities": ["vision", "general"], "license": "Llama 3.2 Community License", "blurb": "High-end vision model; multi-GPU class, for demanding image+text workloads."},
  {"id": "moondream:1.8b", "family": "Moondream", "params": "1.8B", "approxSizeGB": 1.7, "contextTokens": 2048, "contextLabel": "2K", "capabilities": ["vision", "fast"], "license": "Apache 2.0", "recommended": true, "blurb": "Tiny edge VLM; runs on CPU/low VRAM for fast captioning and simple visual questions."},
  {"id": "llava:7b", "family": "LLaVA", "params": "7B", "approxSizeGB": 4.7, "contextTokens": 32768, "contextLabel": "32K", "capabilities": ["vision", "general"], "license": "Apache 2.0 (Vicuna/Llama-based)", "blurb": "Lightweight classic VLM (v1.6); fine for basic image Q&A, surpassed by Qwen2.5-VL/Gemma 3."},
  {"id": "llava:13b", "family": "LLaVA", "params": "13B", "approxSizeGB": 8, "contextTokens": 4096, "contextLabel": "4K", "capabilities": ["vision", "general"], "license": "Apache 2.0 (Vicuna/Llama-based)", "blurb": "Mid LLaVA v1.6; better captioning/VQA than 7B."},
  {"id": "nomic-embed-text:v1.5", "family": "Nomic Embed", "params": "137M", "approxSizeGB": 0.274, "contextTokens": 2048, "contextLabel": "2K", "capabilities": ["embedding", "long-context"], "license": "Apache 2.0", "recommended": true, "blurb": "Go-to local embedding model; large 8K-ish context, great quality-per-byte for RAG."},
  {"id": "bge-m3:567m", "family": "BGE-M3", "params": "567M", "approxSizeGB": 1.2, "contextTokens": 8192, "contextLabel": "8K", "capabilities": ["embedding", "multilingual", "long-context"], "license": "MIT", "recommended": true, "blurb": "Multilingual, multi-granularity embeddings (dense+sparse+ColBERT), 8K context; best pick for non-English/long-doc RAG."},
  {"id": "mxbai-embed-large:335m", "family": "MixedBread mxbai", "params": "335M", "approxSizeGB": 0.67, "contextTokens": 512, "contextLabel": "512", "capabilities": ["embedding"], "license": "Apache 2.0", "blurb": "High-accuracy English embeddings; strong retrieval at a small footprint (512 ctx)."},
  {"id": "codellama:13b", "family": "CodeLlama", "params": "13B", "approxSizeGB": 7.4, "contextTokens": 16384, "contextLabel": "16K", "capabilities": ["coding"], "license": "Llama 2 Community License", "blurb": "Legacy Meta code model; still useful for code/instruct/python variants but outclassed by Qwen2.5-Coder."},
  {"id": "codellama:34b", "family": "CodeLlama", "params": "34B", "approxSizeGB": 19, "contextTokens": 16384, "contextLabel": "16K", "capabilities": ["coding"], "license": "Llama 2 Community License", "blurb": "Largest practical CodeLlama; choose only if you specifically need the Llama-2 lineage."},
  {"id": "smollm2:1.7b", "family": "SmolLM2", "params": "1.7B", "approxSizeGB": 1.8, "contextTokens": 8192, "contextLabel": "8K", "capabilities": ["general", "fast"], "license": "Apache 2.0", "blurb": "Capable tiny model, but at 1.7B qwen3:1.7b and llama3.2 offer tools and longer context."},
  {"id": "smollm2:360m", "family": "SmolLM2", "params": "360M", "approxSizeGB": 0.726, "contextTokens": 8192, "contextLabel": "8K", "capabilities": ["general", "fast"], "license": "Apache 2.0", "blurb": "Pocket-size SmolLM2; usable for simple tasks and on-device demos, not a general daily driver."},
  {"id": "smollm2:135m", "family": "SmolLM2", "params": "135M", "approxSizeGB": 0.271, "contextTokens": 8192, "contextLabel": "8K", "capabilities": ["general", "fast"], "license": "Apache 2.0", "blurb": "Ultra-tiny model for edge/embedded experiments; basic instruction-following only, 8K context."},
];

/** The Control Center default view intentionally stays short: reliable, popular
 *  Ollama tags that are good agent backbones across common desktop hardware. */
const TOP_LOCAL_MODEL_IDS = [
  'qwen3:1.7b',
  'qwen3:4b',
  'qwen3:8b',
  'llama3.2:3b',
  'llama3.1:8b',
  'gemma3:4b',
  'phi4-mini:3.8b',
  'qwen2.5-coder:7b',
  'deepseek-r1:8b',
  'mistral-nemo:12b',
] as const;

export const TOP_LOCAL_MODEL_CATALOG: LocalModelEntry[] = TOP_LOCAL_MODEL_IDS
  .map((id) => LOCAL_MODEL_CATALOG.find((m) => m.id === id))
  .filter((m): m is LocalModelEntry => !!m);
