/**
 * lib/matching/embeddings.ts
 *
 * Embedding-based cross-platform matching pipeline (ADR-0003).
 *
 * Provider: OpenAI text-embedding-3-small (1536 dimensions).
 * Storage: Float32Array serialized as BLOB in watched_questions.embedding.
 * Fallback: returns null on any provider failure; caller falls back to Phase-1 Wire search.
 *
 * In WIRE_MODE=fixtures: reads pre-computed embeddings from
 * tests/fixtures/embeddings/embeddings.json (no live API calls).
 */

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CandidateMarket {
  marketId: string;
  title: string;
  platform: string;
}

export interface EmbeddingMatchResult {
  marketId: string;
  platform: string;
  matchScore: number;
}

// ---------------------------------------------------------------------------
// Fixture embeddings (WIRE_MODE=fixtures)
// ---------------------------------------------------------------------------

let _fixtureCache: Record<string, number[] | null> | null = null;

function loadFixtureEmbeddings(): Record<string, number[] | null> {
  if (_fixtureCache) return _fixtureCache;

  const repoRoot = process.cwd();
  const fixturePath = join(repoRoot, "tests", "fixtures", "embeddings", "embeddings.json");

  if (!existsSync(fixturePath)) {
    _fixtureCache = {};
    return _fixtureCache;
  }

  try {
    _fixtureCache = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, number[] | null>;
  } catch {
    _fixtureCache = {};
  }
  return _fixtureCache;
}

// ---------------------------------------------------------------------------
// L2 normalization
// ---------------------------------------------------------------------------

function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = vec[i] / norm;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed a single text string.
 * Returns null on failure (caller should fall back to Phase-1 Wire search).
 *
 * In WIRE_MODE=fixtures: serves from tests/fixtures/embeddings/embeddings.json.
 * In live mode: calls OpenAI text-embedding-3-small via OPENAI_API_KEY.
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  // Fixture mode
  if (process.env.WIRE_MODE === "fixtures" || !process.env.OPENAI_API_KEY) {
    const fixtures = loadFixtureEmbeddings();
    if (text in fixtures) {
      const val = fixtures[text];
      if (val === null) return null;
      return l2Normalize(new Float32Array(val));
    }
    // Unknown text in fixture mode — generate a deterministic vector from text hash
    return deterministicEmbedding(text);
  }

  // Live mode: call OpenAI
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    const raw = new Float32Array(json.data[0].embedding);
    return l2Normalize(raw);
  } catch {
    return null;
  }
}

/**
 * Cosine similarity of two L2-normalized Float32 vectors.
 * For normalized vectors, this equals the dot product.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Embedding-based matching pipeline for one query against a list of candidate markets.
 * Returns results sorted by cosine similarity (highest first).
 * Returns null if the embedding provider fails (caller falls back to Phase-1 matcher).
 */
export async function matchWithEmbeddings(
  queryText: string,
  candidateMarkets: CandidateMarket[]
): Promise<EmbeddingMatchResult[] | null> {
  const queryVec = await embedText(queryText);
  if (!queryVec) return null;

  const results: EmbeddingMatchResult[] = [];

  for (const candidate of candidateMarkets) {
    const candidateVec = await embedText(candidate.title);
    if (!candidateVec) continue;

    const score = cosineSimilarity(queryVec, candidateVec);
    results.push({
      marketId: candidate.marketId,
      platform: candidate.platform,
      matchScore: score,
    });
  }

  results.sort((a, b) => b.matchScore - a.matchScore);
  return results;
}

// ---------------------------------------------------------------------------
// Deterministic fallback embedding (for unknown texts in fixture mode)
// ---------------------------------------------------------------------------

function deterministicEmbedding(text: string): Float32Array {
  // Generate a deterministic 1536-dim unit vector from the text
  // using a simple hash-based approach. Not semantically meaningful
  // but stable across runs.
  const dim = 1536;
  const vec = new Float32Array(dim);
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  }

  for (let i = 0; i < dim; i++) {
    // LCG-based pseudo-random
    seed = (seed * 1664525 + 1013904223) >>> 0;
    vec[i] = (seed / 0xffffffff) * 2 - 1;
  }

  return l2Normalize(vec);
}
