# AGENTS.md — atproto-link-language

AD4M link language that stores a Perspective on the **AT Protocol** by riding each
repo's **Merkle Search Tree (MST) commit chain**, unioning across repos, and
projecting links as **`app.bsky.feed.post` records** so Bluesky renders them as
posts.

## Architecture (the load-bearing idea)

Two roles, kept strictly separate:

- **Role A — convergence substrate (source of truth).** Each agent's AT Proto
  repo is an MST with a signed **commit chain** (native authority per repo). The
  neighbourhood state is a **cross-repo OR-Set union** keyed by link hash over all
  members' commit chains.
- **Role B — native projection (derived).** A SHACL-driven transform writes
  Role-A links as `app.bsky.feed.post` records.

Invariants — do not break these:

- `currentRevision()` is a **content hash of the commit-chain head CID(s)** — the
  head commit CID for a single repo, else a deterministic digest of the sorted
  per-repo head CIDs. **Never** a firehose sequence number, a `rev` timestamp, or
  a record count.
- Merge is per-repo **MST commit authority** + a **cross-repo OR-Set union** for
  the neighbourhood; removals carry the original link hash.
- Sync follows commit chains + MST diffs; the local cache is rebuilt from
  commits, never authoritative.
- The projection is a **pure fold of Role A, never read back to rebuild the DAG**.
  Genuinely native-authored posts whose author has **no AD4M DID** are
  echo-suppressed and ingested as new Role-A links.

## Channel-B projection (shared, verbatim)

`src/projection/` is a **protocol-agnostic SHACL→native transformer copied
verbatim** across all Channel-B languages (matrix, nostr, atproto, solid, ap):
`bridge.ts`, `expression.ts`, `index.ts`, `literal.ts`, `profile.ts`,
`project.ts`, `types.ts`. **Do not edit it in isolation** — mirror any change to
every Channel-B repo or the copies drift (asserted identical by diff). A
`NodeShape` annotated `projection://nativeType` selects the native body property;
`projection://field` marks projected properties. `src/atproto-projection.ts` is
the thin per-protocol `NativeAdapter` mapping to/from an `app.bsky.feed.post`.

## Layout

- `src/mst.ts` — Merkle Search Tree model, commit chain, MST diff.
- `src/cid.ts` — dag-cbor encoding + CIDv1 commit-CID.
- `src/orset.ts` — cross-repo OR-Set union keyed by link hash.
- `src/lexicon.ts` — AT Proto lexicon record definitions.
- `src/xrpc.ts` — XRPC client calls (com.atproto / app.bsky).
- `src/auth.ts` — PDS session auth.
- `src/atproto-projection.ts` — the `app.bsky.feed.post` `NativeAdapter` (Channel B).
- `src/projection/` — the shared SHACL transformer (see above).
- `src/rendering.ts` — link → post body rendering helpers.
- `src/sync.ts` — commit-chain head tracking → MST diff → cross-repo fold → diff.
- `src/translate.ts` — link ↔ record translation.
- `src/store.ts` — derived link cache + query indexes.
- `src/{settings,types}.ts` — settings + shared types.
- `src/adapters.ts` / `src/adapters-deno.ts` — injected adapters; `ad4m:host`
  confined to `adapters-deno.ts` + `index.ts`.

## Build / test / typecheck

```bash
NODE_ENV=development pnpm install     # NODE_ENV=production skips devDeps — installs look broken
deno run --allow-all esbuild.ts       # bundle → build/ (needs @coasys/ad4m-ldk at ../ad4m/ad4m-ldk/js or AD4M_LDK_ENTRY)
npx tsc --noEmit                      # typecheck — the ONLY type gate; tsx/esbuild transpile without checking
node --experimental-vm-modules --import tsx --test tests/*.test.ts   # full suite
```

ESM imports use explicit `.js` extensions even for `.ts` sources. `npm test`
summary lines are `ℹ tests N` / `ℹ pass N` / `ℹ fail N`.

## What's unit-tested vs what needs a live backend

Hermetic: MST model + commit-CID, cross-repo OR-Set union, revision stability,
and the projection (`app.bsky.feed.post` payload shape + echo-suppressed ingest)
against in-memory fixtures. **Not** in CI: a live PDS round-trip and **live
rendering in Bluesky**.

## Gotchas

- **The executor discards `sync()`'s return value.** `Language::sync()` runs the
  handler purely for side effects; a folded peer delta becomes queryable via
  `perspective.queryLinks` **only** when pushed through the host's
  `emitPerspectiveDiff` channel. Folding into the local store keeps `render()` /
  `currentRevision()` correct but leaves peer links invisible to the executor's
  perspective — a silent add-freeze under multi-agent convergence. Both `init()`
  and the sync handler route through `foldAndEmit` (`src/sync.ts`), the single
  seam that folds **and** emits; keep it that way. Regression-guarded in
  `tests/sync.test.ts`.
- The AT Proto firehose is one-way, so there is no telepresence channel — do not
  claim presence support.
- `src/projection/` is shared — edit here and propagate, never fork.
