# AT Protocol Link Language for AD4M

An AD4M link language that rides the AT Protocol's signed **MST commit-chain** to
give a Perspective genuine multi-agent CRDT convergence. Each participating agent
writes links to its own PDS repo; the shared link set is the **cross-repo OR-Set
union** of every repo's records, and the Perspective's revision is a real content
hash of the commit heads — not a pagination cursor.

This honours AD4M's `perspective-sync` contract (bidirectional full-replica
convergence over a hash-linked diff-DAG) rather than faking it with a snapshot.

## How Convergence Works

AD4M drives two roles through a link language. This language keeps them strictly
separated (the two-channel split — see also "Role B — native projection" below):

- **Channel A — convergence substrate (source of truth).** The AT repo's MST
  commit-chain. Every commit is a real `CIDv1(dag-cbor, sha-256)` over the record
  set. Adds and removes are *records* (`ad4m.link.triple` / `ad4m.link.tombstone`),
  and convergence is decided by set algebra over record content-hashes — never by
  reading a projection back. Channel A publishes the WHOLE perspective (every link
  and all SDNA) on every commit, independent of the rendering strategy.
- **Channel B — native projection (derived, lossy).** A SHACL-driven rendering of
  AD4M subject-class instances into native `app.bsky.feed.post` records
  (`src/projection/` + `src/atproto-projection.ts`), so native Bluesky clients
  display them. Produced *from* Channel A; never read back as truth.

### Revision = commit-CID, not a cursor

`currentRevision()` returns a **version-vector digest of the per-repo commit-CID
heads** (`src/store.ts` `getRevision` → `src/orset.ts` `versionVectorDigest`):

- no heads → `""`;
- exactly one writer → that writer's commit CID verbatim;
- multiple writers → a stable hash of the sorted `did=commitCid` head set.

Because it is derived from content hashes, the revision changes deterministically
whenever any repo's content changes, is independent of head insertion order, and
is stable across restarts for the same state (the head is persisted, not
recomputed from a live cursor).

### Sync = MST diff between commits

The unit of sync is a repo *commit head* (a content hash), not a `listRecords`
cursor (`src/sync.ts`):

1. `com.atproto.sync.getLatestCommit` yields the repo's current head CID.
2. If the head is unchanged since last sync, nothing is re-fetched.
3. Otherwise the current leaf set is listed and diffed against the last-known
   record CIDs (`diffRepoRecords`): changed/new paths become puts, disappeared
   paths become deletes — exactly the records that changed.

### Multi-agent merge = cross-repo OR-Set union

Each agent writes only to its own repo. The materialised link set is the OR-Set
union across self + peer repos (`src/orset.ts` `foldOrSet`, folded by
`src/store.ts` `foldLinks`):

```
present links = ⋃ (adds across all repos)  \  ⋃ (tombstones across all repos)
```

- **Adds** are `ad4m.link.triple` records.
- **Removals are first-class records.** A removal writes an
  `ad4m.link.tombstone` record carrying the **original link hash**
  (`src/translate.ts`). A tombstone in one repo therefore cancels the matching
  add in another repo, so a delete converges against a remote add.
- The fold is order-independent (pure set algebra), so merging diffs `{d1, d2}`
  in either order yields the same revision hash. Remove-wins under
  observed-remove semantics.

## Commits, Query, Signals

- **Commit:** `store.applyLocalDiff(diff)` turns additions into triple records and
  removals into tombstone records, advances the local commit, and returns the new
  head CID. Records are pushed to the PDS via XRPC
  (`com.atproto.repo.createRecord` / `deleteRecord`).
- **Query:** an indexed in-memory fold of the OR-Set (by source, target,
  predicate).
- **Signals (firehose):** an incoming `at://` record is ingested into the peer
  repo's state (`store.ingestPeerRecords`) and the resulting fold delta is emitted
  to AD4M — the projection is re-derived by folding, never read back.

## Role B — native projection (SHACL-driven)

Channel A gives AD4M genuine convergence, but its records
(`ad4m.link.triple` / `ad4m.link.tombstone`) are invisible to a native Bluesky
client. Role B closes that gap: it renders AD4M subject-class instances into real
`app.bsky.feed.post` records so the timeline shows up in any Bluesky app — while
keeping the DAG strictly on Channel A.

- **SHACL decides the shape, the adapter knows Bluesky.** A projection profile
  (parsed from the perspective's SDNA by `src/projection/profile.ts`, else the
  built-in `defaultFluxMessageProfile`) says *which* graph property fills the
  post and *which* native record type to emit. `src/atproto-projection.ts` is the
  only Bluesky-schema-aware half: it maps the resulting `Projection` to an
  `app.bsky.feed.post` whose `text` is the projected content field and whose
  `createdAt` is the instance timestamp.
- **Projection is derived and lossy — never read back.** `toNative` emits **only**
  native post fields: no `ad4m` envelope, no link hashes, no triple data smuggled
  into `text`. When a diff is committed and the rendering strategy is not
  `native`, `projectInstances` folds the additions into posts and writes them
  alongside the Channel-A substrate; the DAG is never rebuilt from a post.
- **Native ingest — only for pure-Bluesky authors.** During `sync`, after folding
  Channel A, posts authored in peer repos that have **no** AD4M footprint (a DID
  that is neither the local repo nor any repo carrying `ad4m.link.*` records) are
  reversed by `ingestNative` into fresh authoritative links and published back
  through Channel A. A repo that already writes triples is skipped — its posts are
  its own Role-B projection, so re-ingesting them would echo. Ingested AT-URIs are
  remembered for idempotency.

The result is a clean split: Channel A is the whole, authoritative, converging
perspective; Channel B is a one-way human-facing rendering of it (plus a
one-way on-ramp for content that was only ever native).

## Content-Addressing Stack

The DAG-CBOR + sha-256 + CIDv1 stack is implemented pure, in-tree (no
`@atproto/*` / `@ipld/*` dependency), and anchored by a **known-answer test**: the
CID of the empty DAG-CBOR map `{}` matches the ecosystem constant
`bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua`, proving it
reproduces real IPLD/ATProto CIDs rather than an internally-consistent hash.

## Template Variables

| Variable | Description |
|----------|-------------|
| `AT_PDS_URL` | PDS server URL |
| `AT_RELAY_URL` | Relay (BGS) URL for firehose |
| `AT_DID` | Account DID |
| `AT_HANDLE` | Account handle |
| `AT_COLLECTION_NSID` | Triple collection NSID (default: `ad4m.link.triple`) |
| `AT_APP_PASSWORD` | App password for auth |
| `NEIGHBOURHOOD_META` | AD4M neighbourhood metadata |

## Building

```bash
NODE_ENV=development pnpm install
deno run --allow-all esbuild.ts
```

Requires `@coasys/ad4m-ldk` at `../ad4m/ad4m-ldk/js/` or set `AD4M_LDK_ENTRY`.

## Testing

```bash
node --experimental-vm-modules --import tsx --test tests/*.test.ts
```

326 tests across 15 test files, all passing. The convergence core is unit-tested
against fixtures:

- `tests/cid.test.ts` — DAG-CBOR / sha-256 / CIDv1, incl. the empty-map
  known-answer CID.
- `tests/mst.test.ts` — commit-CID determinism (order-independent, DID-sensitive,
  signature-excluded) and MST diff (added / removed / updated / no-change).
- `tests/orset.test.ts` — cross-repo OR-Set fold and version-vector digest.
- `tests/diffdag.test.ts` — the §5 acceptance criteria: revision = content hash,
  DAG-authoritative fold, cross-repo removal convergence, add-after-remove,
  concurrent remove-wins, order-independent merge, projection-derived-by-fold.
- `tests/sync.test.ts` — the MST-diff sync layer (`diffRepoRecords`, `syncRepo`
  head-riding + unchanged-head skip, `syncAll` fold delta).
- `tests/projection.test.ts` — the Channel-B SHACL stack: literal codec, node
  expressions, `parseProfiles`, instance collection + projection, native
  round-trip, and the ATProto adapter (`toNative` emits a clean
  `app.bsky.feed.post`; `fromNative` reverses a located post).
- `tests/channel-b-bridge.test.ts` — the protocol-agnostic bridge glue
  (`toAuthoredLink`, `projectInstances`, `ingestNative`, the Flux fallback
  profile) exercised over the ATProto post adapter.

### What needs a live PDS / federation

A live PDS cannot run in this test environment, so the following are exercised
only at the request-building / response-parsing level, not end-to-end:

- **Wire fetches:** `com.atproto.sync.getLatestCommit` and `listRecords` HTTP
  round-trips against a real PDS (mocked here via an injected `Transport`).
- **Record write-back:** `createRecord` / `deleteRecord` actually persisting to a
  PDS and advancing the *server's* commit head.
- **Cross-agent federation:** two agents on distinct PDS repos observing each
  other's heads via a relay firehose and converging.

The convergence *logic* those flows drive — commit-CID computation, MST diffing,
OR-Set union, and the fold — is fully unit-tested against fixtures above.

## Module Layout

- `src/cid.ts` — pure DAG-CBOR + sha-256 + CIDv1 content-addressing.
- `src/mst.ts` — MST model, commit chain, and MST diff.
- `src/orset.ts` — cross-repo OR-Set union + version-vector digest.
- `src/store.ts` — local + peer repo state, commit advancement, fold, revision.
- `src/sync.ts` — commit-head sync + MST-diff record reconciliation.
- `src/xrpc.ts` — XRPC client (incl. `getLatestCommit`) for PDS communication.
- `src/auth.ts` — app-password authentication + session refresh.
- `src/translate.ts` — link ↔ AT record translation, incl. first-class tombstones,
  dual-language handling, and SDNA link projection.
- `src/projection/` — protocol-agnostic Channel-B core: the SHACL profile parser
  + node-expression evaluator (`profile.ts`, `expression.ts`), the AD4M literal
  codec (`literal.ts`), the graph → `Projection` transformer (`project.ts`), and
  the bridge glue (`bridge.ts`: `projectInstances` / `ingestNative` /
  `defaultFluxMessageProfile`). Identical across every plain-text link language.
- `src/atproto-projection.ts` — the ATProto `NativeAdapter`: the only
  Bluesky-schema-aware half, mapping a `Projection` to/from an
  `app.bsky.feed.post` record (content field `text`).
- `src/lexicon.ts` — custom Lexicon definitions.
- `src/rendering.ts` — Bluesky facet / embed projection.
- `src/settings.ts` — language settings.
- `src/types.ts` — shared link / diff types.
- `src/adapters.ts` / `src/adapters-deno.ts` — injected Transport / Storage /
  Runtime / Signing adapters; `ad4m:host` imports are confined to
  `adapters-deno.ts` + `index.ts`.

Lexicon schemas live in `lexicons/`.

## License

CAL-1.0
