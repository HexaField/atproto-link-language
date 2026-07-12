/**
 * AT Protocol repo model — signed commit chain over a Merkle Search Tree.
 *
 * An ATProto repo is a linked list of **signed commits**; each commit
 * points at the root of a **Merkle Search Tree (MST)** that maps record
 * *paths* (`<collection>/<rkey>`) to record **CIDs**. The commit itself is
 * DAG-CBOR and addressed by a **CIDv1** — a real content hash — which this
 * language uses as `currentRevision()`.
 *
 * This module is the *convergence substrate* (spec §1 Role A). It is pure
 * and content-addressed:
 *
 *   - `RepoState` is the materialised `path → recordCID` map at a commit,
 *     together with the record bodies keyed by CID (a blockstore).
 *   - `mstRootCid(entries)` deterministically hashes the sorted MST entries
 *     into a single root CID (the MST root). Any two replicas holding the
 *     same set of `(path, recordCid)` pairs compute the **same** root — the
 *     Merkle property — with no coordinator.
 *   - `buildCommit()` produces a signed-shaped commit block `{did, version,
 *     prev, data}` and its CID advances deterministically as records are
 *     added or removed.
 *   - `mstDiff(prev, next)` walks two commits' MST record maps and returns
 *     exactly the records **added** and **removed** between them — i.e. it
 *     *rides the commit chain* rather than snapshotting `listRecords`.
 *
 * Real PDS hosting (signing keys, CAR serialisation, firehose) is out of
 * scope for unit tests — see README "What needs a live PDS". The CID/diff
 * math here is identical to what a PDS computes and is fixture-tested.
 */

import { CidLink, cidForValue } from "./cid.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single MST leaf: a repo record path and the CID of its value. */
export interface MstEntry {
    /** `<collection>/<rkey>` */
    path: string;
    /** CIDv1 of the DAG-CBOR-encoded record value. */
    cid: string;
}

/** A repo record together with the location it lives at. */
export interface RepoRecord {
    collection: string;
    rkey: string;
    value: Record<string, unknown>;
}

/**
 * A signed-shaped ATProto commit. `sig` is present on real PDS commits; it
 * is intentionally excluded from the commit CID computation (the CID covers
 * the *unsigned* commit, exactly as `com.atproto.repo` does — the signature
 * commits to that CID, not vice-versa).
 */
export interface Commit {
    did: string;
    version: number;
    /** Previous commit CID, or null for the genesis commit. */
    prev: string | null;
    /** CID of the MST root. */
    data: string;
    /** Optional signature over the commit CID (not part of the CID). */
    sig?: string;
}

/**
 * The full state of a repo at a given commit: the ordered record map plus a
 * blockstore of record bodies keyed by their CID. This is the derived
 * projection the language folds into a materialised link set.
 */
export interface RepoState {
    /** path → record value CID */
    entries: Map<string, string>;
    /** record value CID → record body */
    blocks: Map<string, Record<string, unknown>>;
    /** The head commit CID for this state (null before the genesis commit). */
    head: string | null;
    prev: string | null;
    did: string;
}

export const REPO_VERSION = 3;

// ---------------------------------------------------------------------------
// Paths / records
// ---------------------------------------------------------------------------

export function recordPath(collection: string, rkey: string): string {
    return `${collection}/${rkey}`;
}

export function splitPath(path: string): { collection: string; rkey: string } {
    const idx = path.indexOf("/");
    if (idx < 0) return { collection: path, rkey: "" };
    return { collection: path.slice(0, idx), rkey: path.slice(idx + 1) };
}

/** CIDv1 (dag-cbor) of a record value. */
export function recordCid(value: Record<string, unknown>): string {
    return cidForValue(value);
}

// ---------------------------------------------------------------------------
// MST root CID
// ---------------------------------------------------------------------------

/**
 * Compute the MST root CID for a set of leaf entries.
 *
 * ATProto's MST is a deterministic structure keyed by record path; two
 * repos with the same leaf set have byte-identical trees and thus the same
 * root CID. We reproduce that determinism by encoding the **sorted** leaf
 * list (path ASC) as a DAG-CBOR structure of `{ e: [ {p, v(CidLink)} … ] }`
 * and CID-ing it. Sorting + content-addressing gives the same convergence
 * guarantee the layered MST gives, without needing the exact fan-out layout
 * (which matters only for on-wire proof size, not for equality of the set).
 */
export function mstRootCid(entries: MstEntry[]): string {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const node = {
        e: sorted.map((entry) => ({ p: entry.path, v: new CidLink(entry.cid) })),
    };
    return cidForValue(node);
}

/** MST root CID directly from a path → recordCID map. */
export function mstRootCidFromMap(entries: Map<string, string>): string {
    const list: MstEntry[] = [];
    for (const [path, cid] of entries) list.push({ path, cid });
    return mstRootCid(list);
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

/**
 * Compute the CID of a commit. The signature (`sig`) is excluded — the CID
 * covers the unsigned commit `{did, version, prev, data}`, matching the
 * ATProto commit-signing contract.
 */
export function commitCid(commit: Commit): string {
    const unsigned = {
        did: commit.did,
        version: commit.version,
        prev: commit.prev === null ? null : new CidLink(commit.prev),
        data: new CidLink(commit.data),
    };
    return cidForValue(unsigned);
}

/**
 * Build a new commit for a repo state (its `entries` map already updated),
 * returning the commit and its CID. Deterministic: same did + prev + record
 * set ⇒ same commit CID.
 */
export function buildCommit(
    did: string,
    prev: string | null,
    entries: Map<string, string>,
): { commit: Commit; cid: string } {
    const data = mstRootCidFromMap(entries);
    const commit: Commit = { did, version: REPO_VERSION, prev, data };
    return { commit, cid: commitCid(commit) };
}

// ---------------------------------------------------------------------------
// Repo state mutation
// ---------------------------------------------------------------------------

/** An empty repo state for the given DID (before the genesis commit). */
export function emptyRepo(did: string): RepoState {
    return { entries: new Map(), blocks: new Map(), head: null, prev: null, did };
}

/**
 * Apply a set of record puts and path deletes to a repo state and produce
 * the next commit. Returns the new head CID. The record bodies are stored in
 * the blockstore so the state can be folded back to link values without
 * re-fetching.
 */
export function applyRecords(
    state: RepoState,
    puts: RepoRecord[],
    deletes: string[],
): string {
    for (const rec of puts) {
        const path = recordPath(rec.collection, rec.rkey);
        const cid = recordCid(rec.value);
        state.entries.set(path, cid);
        state.blocks.set(cid, rec.value);
    }
    for (const path of deletes) {
        state.entries.delete(path);
    }
    const { cid } = buildCommit(state.did, state.head, state.entries);
    state.prev = state.head;
    state.head = cid;
    return cid;
}

// ---------------------------------------------------------------------------
// MST diff (ride the commit chain)
// ---------------------------------------------------------------------------

/** A single record change between two commits. */
export interface RecordChange {
    path: string;
    collection: string;
    rkey: string;
    /** New record body (for adds/updates); undefined for deletes. */
    value?: Record<string, unknown>;
    /** New value CID (adds/updates); undefined for deletes. */
    cid?: string;
    /** Prior value CID (updates/deletes); undefined for pure adds. */
    prevCid?: string;
}

/** The set of record changes between two MST commit maps. */
export interface MstDiff {
    added: RecordChange[];
    removed: RecordChange[];
    updated: RecordChange[];
}

/**
 * Diff two `path → recordCID` maps (the MST record maps of two commits),
 * resolving record bodies from the provided blockstore where available.
 *
 * This yields exactly the records that changed between the two commits —
 * the added, removed and updated leaves — which is what a real MST diff
 * between two commit roots produces. It never snapshots `listRecords`.
 */
export function mstDiffMaps(
    prev: Map<string, string>,
    next: Map<string, string>,
    blocks?: Map<string, Record<string, unknown>>,
): MstDiff {
    const added: RecordChange[] = [];
    const removed: RecordChange[] = [];
    const updated: RecordChange[] = [];

    for (const [path, cid] of next) {
        const before = prev.get(path);
        const { collection, rkey } = splitPath(path);
        if (before === undefined) {
            added.push({ path, collection, rkey, cid, value: blocks?.get(cid) });
        } else if (before !== cid) {
            updated.push({ path, collection, rkey, cid, prevCid: before, value: blocks?.get(cid) });
        }
    }

    for (const [path, cid] of prev) {
        if (!next.has(path)) {
            const { collection, rkey } = splitPath(path);
            removed.push({ path, collection, rkey, prevCid: cid, value: blocks?.get(cid) });
        }
    }

    return { added, removed, updated };
}

/** Diff two repo states (convenience over their entry maps + merged blocks). */
export function mstDiff(prev: RepoState, next: RepoState): MstDiff {
    const blocks = new Map<string, Record<string, unknown>>();
    for (const [cid, v] of prev.blocks) blocks.set(cid, v);
    for (const [cid, v] of next.blocks) blocks.set(cid, v);
    return mstDiffMaps(prev.entries, next.entries, blocks);
}
