# ADR 0003 — Embedding-based cross-platform matching

Date: 2026-05-11
Status: Accepted
Supersedes: —
References: ADR-0001 (stack), ADR-0002 (Wire integration), BACKLOG.yaml task-embedding-*

## Context

Phase 1 matches user queries to markets using Wire's free-text search
(`mm_search_markets`, `kl_events`, `pm_get_events`, `rh_get_events`). The
search-based approach has two failure modes:

1. **Lexical mismatch**: "Will the Fed raise rates in 2026?" and "2026 Federal
   Reserve rate hike" retrieve different result sets even when they refer to the
   same event.
2. **Recall gaps**: searches return the first page of results; semantically
   relevant markets on page 2+ are silently skipped.

Phase 2 goal: ≥80% accuracy on a seeded eval set of ≥20 (query, ground-truth
market) pairs, measured by top-1 hit rate across all four platforms.

Constraints inherited from ADR-0001:
- Vercel Hobby Node 20 runtime; max function execution 10 s.
- SQLite only (no Neon pgvector available at this budget).
- `WIRE_MODE=fixtures` must work end-to-end in tests with no live API calls.
- The BYO-Anakin-key model means Wire calls are already scoped per user; the
  embedding provider is a separate, server-side (shared) API call.

## Options considered

### Provider

| # | Provider | Dimensions | Cost (1 k calls) | Latency p50 | Offline / fixture |
|---|----------|-----------|-----------------|-------------|-------------------|
| 1 | **OpenAI text-embedding-3-small** | 1536 | ~$0.002 | ~100 ms | No |
| 2 | Anakin Wire embedding action | TBD | BYO key | TBD | Yes (fixtures) |
| 3 | sentence-transformers (self-hosted) | 768 | $0 (compute) | 200–400 ms (CPU) | Yes |
| 4 | Cohere embed-v3-multilingual | 1024 | ~$0.01 | ~120 ms | No |

**Decision: OpenAI text-embedding-3-small (option 1)** with a Blob-column cache
in SQLite, falling back to Phase-1 free-text search when the key is absent.

Rationale:
- Best accuracy-per-dollar benchmark among cloud providers at this embedding dim.
- text-embedding-3-small at 1536d is compact enough for SQLite BLOB storage
  without triggering page-size issues (≤ 6 kB per embedding as Float32).
- Phase-1 fallback keeps the app functional for users who haven't set an
  `OPENAI_API_KEY` env var; no forced migration.
- sentence-transformers (option 3) requires an always-on process (Lambda Cold
  start too slow) or a worker dyno — incompatible with Vercel Hobby.

### Storage

| # | Storage | Lookup | Setup complexity |
|---|---------|--------|-----------------|
| A | **SQLite BLOB column** (Float32, 1536d) | Cosine scan over all rows | Zero |
| B | Neon pgvector | IVFFlat ANN | Requires Neon plan |
| C | Pinecone / Weaviate | ANN | Third-party dependency |

**Decision: SQLite BLOB (option A)**

At Phase 2 scale (< 1 000 active markets per platform) a full cosine scan over
all stored embeddings completes in < 10 ms in Node.js. No external vector DB
needed. This is revisited in Phase 3 when market counts grow.

### Retrieval algorithm

Cosine similarity: `sim(a, b) = dot(a, b)` where both vectors are L2-normalized
at insert time. This avoids division at query time.

### Fallback semantics

If `OPENAI_API_KEY` is not set, or the embedding call returns an error:
1. Log a warning.
2. Fall through to Phase-1 Wire search (`matchQuestion` in lib/matching.ts).
3. The question gets a match, just possibly lower accuracy.

No user-visible error is shown; the spread computation degrades gracefully.

## Decisions locked for implementation

| Key | Value |
|-----|-------|
| Provider | OpenAI text-embedding-3-small |
| Embedding dimensions | 1536 |
| Storage column | `watched_questions.embedding BLOB` (Float32 LE, 1536 × 4 = 6144 bytes) |
| Match score column | `question_matches.match_score REAL` |
| Normalization | L2-normalize at insert; cosine sim = dot product at query |
| Fallback | Phase-1 Wire search when OPENAI_API_KEY absent or provider error |
| Fixture mode | `WIRE_MODE=fixtures` skips OpenAI call; uses fixture embeddings from `tests/fixtures/embeddings/` |
| Cost projection | 20 eval queries + ≤ 5 k market titles = ~5.5 k embeddings ≈ $0.01 one-time at current pricing |
| Eval accuracy target | ≥ 80% top-1 hit rate over the ≥ 20 query eval set |

## Schema changes

```sql
-- watched_questions gains a nullable embedding column
ALTER TABLE watched_questions ADD COLUMN embedding BLOB;

-- question_matches gains a match_score column (cosine similarity, null for Phase-1 matches)
ALTER TABLE question_matches ADD COLUMN match_score REAL;
```

## Implementation contract

`lib/matching/embeddings.ts` must export:

```typescript
// Embed a single text string. Returns null on failure (triggers fallback).
export async function embedText(text: string): Promise<Float32Array | null>;

// Cosine similarity of two L2-normalized Float32 vectors (= dot product).
export function cosineSimilarity(a: Float32Array, b: Float32Array): number;

// Full embedding-based matching pipeline for one query.
// Returns null if embedding fails (caller falls back to Phase-1 matcher).
export async function matchWithEmbeddings(
  queryText: string,
  candidateMarkets: CandidateMarket[]
): Promise<EmbeddingMatchResult[] | null>;
```

## Tradeoffs and risks

- **Latency**: embedding calls add ~100 ms per question on the critical path of
  `POST /api/watched`. Acceptable because this is a background match, not
  user-visible response time (the question is saved before the match).
- **Cost**: OpenAI charges per token; aggressive caching (store embedding in
  `watched_questions.embedding`) ensures each query is embedded at most once.
- **Phase-1 regression risk**: the fallback is explicit and tested; Phase-1
  alert accuracy is unaffected when OPENAI_API_KEY is unset.
- **Eval set freshness**: the eval YAML is committed; market IDs may go stale.
  Eval tests use fixture mode (no live calls), so staleness only matters for
  live smoke tests, not CI.
