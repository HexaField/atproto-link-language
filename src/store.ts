/**
 * Link store — MST commit-chain substrate + derived link cache.
 *
 * Per spec §1/§2, the **convergence substrate is authoritative** and the
 * materialised link set is a *derived cache*. Concretely:
 *
 *   - The AD4M-facing source of truth is a set of **ATProto repos** (this
 *     agent's own repo + every discovered peer repo), each an MST commit
 *     chain of `ad4m.link.triple` records (adds) and `ad4m.link.tombstone`
 *     records (first-class removals carrying the original link hash).
 *   - The materialised link set is the **cross-repo OR-Set union** folded
 *     from those repos (adds minus tombstones, keyed by link hash) — it is
 *     recomputed from the substrate, never treated as primary. A unit test
 *     folds the repos from genesis and reproduces the link set (spec §5.2).
 *   - `currentRevision()` is the **version-vector digest** of the per-repo
 *     commit-CID heads (or the single commit CID when solo) — a real content
 *     hash, deterministic and stable across restarts for the same state.
 *
 * Persistence: the local repo's record set + head and each peer repo's
 * record set + head are serialised to KV so state survives restarts. The
 * link cache is rebuilt from them.
 *
 * No ad4m:host imports — uses injected StorageAdapter + RuntimeAdapter.
 */

import { getStorage, getRuntime } from "./adapters.js";
import type { LinkExpression, PerspectiveDiff, Perspective, Ad4mLinkTriple } from "./types.js";
import {
    type RepoState,
    type RepoRecord,
    emptyRepo,
    applyRecords,
    recordPath,
    recordCid,
    buildCommit,
} from "./mst.js";
import { foldOrSet, versionVectorDigest, type RepoContribution } from "./orset.js";
import {
    linkHash as computeLinkHash,
    tripleRecordToLink,
    tombstoneLinkHash,
    isTombstoneRecord,
    linkToTripleRecord,
    linkToTombstoneRecord,
} from "./translate.js";
import { TRIPLE_COLLECTION, TOMBSTONE_COLLECTION } from "./lexicon.js";

let _hashFn: ((data: string) => string) | null = null;

/** Initialize the store module. */
export function initStore(hashFn?: (data: string) => string): void {
    _hashFn = hashFn ?? null;
    _local = null;
    _peers.clear();
}

function getHashFn(): (data: string) => string {
    if (_hashFn) return _hashFn;
    return getRuntime().hash;
}

// ---------------------------------------------------------------------------
// KV key scheme
// ---------------------------------------------------------------------------
//   repo/self/head                  → local commit CID
//   repo/self/did                   → local repo DID
//   repo/self/rec/{path}            → serialized record value (adds+tombstones)
//   repo/peer/{did}/head            → peer commit CID (last folded)
//   repo/peer/{did}/rec/{path}      → serialized peer record value
//   peers/{did}                     → peer metadata JSON (discovery)
// ---------------------------------------------------------------------------

const SELF_HEAD_KEY = "repo/self/head";
const SELF_DID_KEY = "repo/self/did";
const SELF_REC_PREFIX = "repo/self/rec/";

function peerHeadKey(did: string): string { return `repo/peer/${did}/head`; }
function peerRecPrefix(did: string): string { return `repo/peer/${did}/rec/`; }
function peerKey(did: string): string { return `peers/${did}`; }

// ---------------------------------------------------------------------------
// In-memory repo state (rehydrated from KV on demand)
// ---------------------------------------------------------------------------

let _local: RepoState | null = null;
const _peers = new Map<string, RepoState>();

function serializeRecord(value: Record<string, unknown>): string {
    return JSON.stringify(value);
}
function deserializeRecord(raw: string): Record<string, unknown> {
    return JSON.parse(raw) as Record<string, unknown>;
}

/** Load the local repo state from KV (or create an empty one). */
function loadLocal(): RepoState {
    if (_local) return _local;
    const storage = getStorage();
    const did = storage.get(SELF_DID_KEY) || "";
    const state = emptyRepo(did);
    const keys = storage.listKeys(SELF_REC_PREFIX);
    for (const key of keys) {
        const raw = storage.get(key);
        if (!raw) continue;
        const path = key.slice(SELF_REC_PREFIX.length);
        const value = deserializeRecord(raw);
        // recompute record CID deterministically and index it
        applyRecordInMemory(state, path, value);
    }
    state.head = storage.get(SELF_HEAD_KEY) || rebuildHead(state);
    _local = state;
    return state;
}

/** Index a record into a repo state's entries+blocks without committing. */
function applyRecordInMemory(state: RepoState, path: string, value: Record<string, unknown>): void {
    const cid = recordCid(value);
    state.entries.set(path, cid);
    state.blocks.set(cid, value);
}

/**
 * Rebuild the head commit CID from the current record set. Used when
 * rehydrating from KV, where only the record bodies are persisted (not the
 * prev-chain). The head is a deterministic function of `did` + record set, so
 * the same materialised state always yields the same head CID — which is what
 * makes `currentRevision()` stable across restarts.
 */
function rebuildHead(state: RepoState): string | null {
    if (state.entries.size === 0) return null;
    const { cid } = buildCommit(state.did, null, state.entries);
    return cid;
}

function persistLocal(state: RepoState): void {
    const storage = getStorage();
    if (state.did) storage.put(SELF_DID_KEY, state.did);
    if (state.head) storage.put(SELF_HEAD_KEY, state.head);
}

/** Set the DID this agent's repo is published under. */
export function setLocalDid(did: string): void {
    const state = loadLocal();
    state.did = did;
    getStorage().put(SELF_DID_KEY, did);
    // DID participates in the commit; refresh the head.
    state.head = rebuildHead(state);
    persistLocal(state);
}

export function getLocalDid(): string {
    return loadLocal().did;
}

// ---------------------------------------------------------------------------
// Local commits — additions and first-class removals
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash for a LinkExpression (its OR-Set element key
 * — full triple + author + timestamp). Kept public for existing callers.
 */
export function hashLink(link: LinkExpression): string {
    return computeLinkHash(link, getHashFn());
}

/**
 * Apply a full PerspectiveDiff to the LOCAL repo: additions become
 * `ad4m.link.triple` records, removals become `ad4m.link.tombstone` records
 * carrying the original link hash. Advances the local commit CID. Returns
 * the new local commit CID.
 */
export function applyLocalDiff(diff: PerspectiveDiff): string {
    const state = loadLocal();
    const hashFn = getHashFn();
    const puts: RepoRecord[] = [];
    const storage = getStorage();

    for (const link of diff.additions) {
        const record = linkToTripleRecord(link) as unknown as Record<string, unknown>;
        const rkey = rkeyForLink(link, hashFn);
        puts.push({ collection: TRIPLE_COLLECTION, rkey, value: record });
    }
    for (const link of diff.removals) {
        const record = linkToTombstoneRecord(link, hashFn) as unknown as Record<string, unknown>;
        const rkey = rkeyForLink(link, hashFn);
        puts.push({ collection: TOMBSTONE_COLLECTION, rkey, value: record });
    }

    const head = applyRecords(state, puts, []);

    // Persist the new records + head.
    for (const p of puts) {
        storage.put(SELF_REC_PREFIX + recordPath(p.collection, p.rkey), serializeRecord(p.value));
    }
    persistLocal(state);
    return head;
}

/**
 * A stable rkey for a link — derived from its OR-Set hash so the add and its
 * tombstone can be co-located and duplicate adds are idempotent.
 */
function rkeyForLink(link: LinkExpression, hashFn: (data: string) => string): string {
    return computeLinkHash(link, hashFn);
}

/**
 * Ingest records observed in the LOCAL repo at a PDS-reported head commit CID.
 *
 * This is the inbound counterpart to {@link applyLocalDiff}: it reconciles the
 * local in-memory state with what the PDS actually holds (e.g. after a sync
 * pulls the repo's own current leaf set), adopting the PDS's signed commit CID
 * as the authoritative head rather than recomputing one locally.
 */
export function ingestSelfRecords(
    puts: RepoRecord[],
    deletePaths: string[],
    newHead: string | null,
): void {
    const state = loadLocal();
    const storage = getStorage();
    for (const p of puts) {
        const path = recordPath(p.collection, p.rkey);
        applyRecordInMemory(state, path, p.value);
        storage.put(SELF_REC_PREFIX + path, serializeRecord(p.value));
    }
    for (const path of deletePaths) {
        state.entries.delete(path);
        storage.delete(SELF_REC_PREFIX + path);
    }
    if (newHead) {
        state.head = newHead;
        storage.put(SELF_HEAD_KEY, newHead);
    }
}

/** The local repo's current `path → recordCID` map (for MST diffing). */
export function localEntryCids(): Map<string, string> {
    return new Map(loadLocal().entries);
}

// ---------------------------------------------------------------------------
// Peer repos (cross-repo union)
// ---------------------------------------------------------------------------

/** Load a peer's repo state from KV (or create an empty one). */
function loadPeer(did: string): RepoState {
    const cached = _peers.get(did);
    if (cached) return cached;
    const storage = getStorage();
    const state = emptyRepo(did);
    const prefix = peerRecPrefix(did);
    const keys = storage.listKeys(prefix);
    for (const key of keys) {
        const raw = storage.get(key);
        if (!raw) continue;
        const path = key.slice(prefix.length);
        applyRecordInMemory(state, path, deserializeRecord(raw));
    }
    state.head = storage.get(peerHeadKey(did)) || rebuildHead(state);
    _peers.set(did, state);
    return state;
}

/**
 * Ingest records observed in a peer's repo (e.g. from an MST diff or a full
 * listing) at a new head commit CID. Records are persisted so the peer repo
 * survives restarts; the derived link cache is the caller's concern.
 */
export function ingestPeerRecords(
    did: string,
    puts: RepoRecord[],
    deletePaths: string[],
    newHead: string | null,
): void {
    const state = loadPeer(did);
    const storage = getStorage();
    for (const p of puts) {
        const path = recordPath(p.collection, p.rkey);
        applyRecordInMemory(state, path, p.value);
        storage.put(peerRecPrefix(did) + path, serializeRecord(p.value));
    }
    for (const path of deletePaths) {
        state.entries.delete(path);
        storage.delete(peerRecPrefix(did) + path);
    }
    if (newHead) {
        state.head = newHead;
        storage.put(peerHeadKey(did), newHead);
    }
}

/** The last-known commit CID we folded for a peer repo. */
export function getPeerHead(did: string): string | null {
    return getStorage().get(peerHeadKey(did));
}

/** A peer repo's current `path → recordCID` map (for MST diffing). */
export function peerEntryCids(did: string): Map<string, string> {
    return new Map(loadPeer(did).entries);
}

/** All peer DIDs with a materialised repo state. */
export function peerRepoDids(): string[] {
    const heads = getStorage().listKeys("repo/peer/");
    const dids = new Set<string>();
    for (const key of heads) {
        // repo/peer/{did}/...
        const rest = key.slice("repo/peer/".length);
        const slash = rest.indexOf("/");
        if (slash > 0) dids.add(rest.slice(0, slash));
    }
    return [...dids];
}

// ---------------------------------------------------------------------------
// OR-Set fold → derived link set
// ---------------------------------------------------------------------------

/** Build a repo's OR-Set contribution + collect link bodies by hash. */
function contributionOf(
    state: RepoState,
    links: Map<string, LinkExpression>,
): RepoContribution {
    const adds = new Set<string>();
    const tombstones = new Set<string>();
    for (const [path, cid] of state.entries) {
        const value = state.blocks.get(cid);
        if (!value) continue;
        if (isTombstoneRecord(value)) {
            const h = tombstoneLinkHash(value);
            if (h) tombstones.add(h);
        } else if (value.$type === "ad4m.link.triple") {
            const link = tripleRecordToLink(value as unknown as Ad4mLinkTriple);
            const h = computeLinkHash(link, getHashFn());
            adds.add(h);
            links.set(h, link);
        }
    }
    return { adds, tombstones };
}

/**
 * Fold the entire substrate (local repo + all peer repos) into the present
 * link set. This is the derivation the materialised cache is a view of;
 * calling it from genesis reproduces the link set (spec §5.2).
 */
export function foldLinks(): LinkExpression[] {
    const links = new Map<string, LinkExpression>();
    const contributions: RepoContribution[] = [];

    contributions.push(contributionOf(loadLocal(), links));
    for (const did of peerRepoDids()) {
        contributions.push(contributionOf(loadPeer(did), links));
    }

    const { present } = foldOrSet(contributions);
    const out: LinkExpression[] = [];
    for (const h of present) {
        const link = links.get(h);
        if (link) out.push(link);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Revision — version-vector digest of repo heads
// ---------------------------------------------------------------------------

/**
 * `currentRevision()` — a version-vector digest of every participating repo's
 * commit-CID head. Solo (only the local repo): the single commit CID. Empty:
 * "". Deterministic and stable across restarts for the same repo heads.
 */
export function getRevision(): string {
    const heads = new Map<string, string>();
    const local = loadLocal();
    if (local.head) heads.set(local.did || "self", local.head);
    for (const did of peerRepoDids()) {
        const h = getPeerHead(did);
        if (h) heads.set(did, h);
    }
    return versionVectorDigest(heads, getHashFn());
}

/** The local repo's own commit CID head (null before the genesis commit). */
export function getLocalHead(): string | null {
    return loadLocal().head;
}

// ---------------------------------------------------------------------------
// Query API (derived — folds the substrate then filters)
// ---------------------------------------------------------------------------

export interface LinkQuery {
    source?: string;
    target?: string;
    predicate?: string;
}

/** Query the derived link set by pattern. */
export function queryLinks(query: LinkQuery): LinkExpression[] {
    const { source, target, predicate } = query;
    return foldLinks().filter((link) => {
        if (source !== undefined && link.data.source !== source) return false;
        if (target !== undefined && link.data.target !== target) return false;
        if (predicate !== undefined && link.data.predicate !== predicate) return false;
        return true;
    });
}

/** Return the derived link set as a Perspective. */
export function allLinks(): Perspective {
    return { links: foldLinks() };
}

/** Count of present (folded) links. */
export function linkCount(): number {
    return foldLinks().length;
}

/** True if a link (by OR-Set hash) is currently present. */
export function hasLink(link: LinkExpression): boolean {
    const target = computeLinkHash(link, getHashFn());
    return foldLinks().some((l) => computeLinkHash(l, getHashFn()) === target);
}

// ---------------------------------------------------------------------------
// Peer discovery metadata
// ---------------------------------------------------------------------------

export function setPeer(did: string, metadata: Record<string, unknown> = {}): void {
    getStorage().put(peerKey(did), JSON.stringify(metadata));
}

export function removePeer(did: string): void {
    getStorage().delete(peerKey(did));
}

export function listPeers(prefix: string = "peers/"): string[] {
    const keys = getStorage().listKeys(prefix);
    return keys.map((k: string) => k.replace(prefix, ""));
}

export function getPeerMetadata(did: string): Record<string, unknown> | null {
    const raw = getStorage().get(peerKey(did));
    if (!raw) return null;
    return JSON.parse(raw);
}
