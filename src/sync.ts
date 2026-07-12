/**
 * Sync — ride the MST commit chain, converge via the cross-repo OR-Set.
 *
 * This replaces the old cursor-snapshot sync. The unit of sync is a **repo
 * commit head** (`com.atproto.sync.getLatestCommit` → a real commit CID), not
 * a `listRecords` pagination cursor:
 *
 *   1. For each participating repo (this agent's own repo + every discovered
 *      peer repo) fetch its current head commit CID.
 *   2. If the head is **unchanged** since we last folded it, the repo has no
 *      new links — skip it entirely (no records re-fetched).
 *   3. Otherwise fetch the repo's current record set and compute the **MST
 *      diff** against the record set we previously ingested for that repo
 *      (added / removed leaves — {@link diffRepoRecords}). Ingest the delta
 *      into the store at the new head.
 *   4. After all repos are folded, return the **OR-Set convergence delta**:
 *      the links that entered or left the materialised set (union of adds
 *      minus tombstones across all repos) as a `PerspectiveDiff`.
 *
 * The MST-diff core (`diffRepoRecords`) and the OR-Set fold (in `store`) are
 * pure and fixture-tested. Fetching heads/records needs a live PDS — see
 * README "What needs a live PDS".
 *
 * No ad4m:host imports — uses injected adapters.
 */

import type { PerspectiveDiff, LinkExpression } from "./types.js";
import { getRuntime } from "./adapters.js";
import * as xrpc from "./xrpc.js";
import * as store from "./store.js";
import { recordPath, splitPath, recordCid, type RepoRecord } from "./mst.js";
import { TRIPLE_COLLECTION, TOMBSTONE_COLLECTION } from "./lexicon.js";
import { linkHash } from "./translate.js";

// ---------------------------------------------------------------------------
// Repo-record MST diff (pure core)
// ---------------------------------------------------------------------------

/** A record observed in a repo listing, at its `<collection>/<rkey>` path. */
export interface ObservedRecord {
    collection: string;
    rkey: string;
    value: Record<string, unknown>;
}

/** The record-level delta between a repo's prior and current state. */
export interface RepoRecordDelta {
    /** Records added or updated since the prior state (to be ingested). */
    puts: RepoRecord[];
    /** Paths that disappeared since the prior state (to be removed). */
    deletePaths: string[];
}

/**
 * Compute the record-level MST diff for a single repo.
 *
 * `priorEntries` is the `path → recordCID` map we last ingested for this repo
 * (empty on first sync). `current` is the repo's current record set. We
 * content-address each current record and compare against the prior CID at
 * that path:
 *
 *   - path absent before, or CID changed  → a **put** (add / update leaf)
 *   - path present before but gone now     → a **delete** (removed leaf)
 *
 * This is exactly the set of leaves an MST diff between the two commit roots
 * yields — it rides the commit chain rather than snapshotting the full list.
 */
export function diffRepoRecords(
    priorEntries: Map<string, string>,
    current: ObservedRecord[],
): RepoRecordDelta {
    const puts: RepoRecord[] = [];
    const seen = new Set<string>();

    for (const rec of current) {
        const path = recordPath(rec.collection, rec.rkey);
        seen.add(path);
        const cid = recordCid(rec.value);
        if (priorEntries.get(path) !== cid) {
            puts.push({ collection: rec.collection, rkey: rec.rkey, value: rec.value });
        }
    }

    const deletePaths: string[] = [];
    for (const path of priorEntries.keys()) {
        if (!seen.has(path)) deletePaths.push(path);
    }

    return { puts, deletePaths };
}

// ---------------------------------------------------------------------------
// Live sync (needs a PDS)
// ---------------------------------------------------------------------------

export interface RepoSyncTarget {
    /** The repo's DID. `self` for the local agent's own repo. */
    did: string;
    /** The PDS base URL the repo is hosted on. */
    pdsUrl: string;
    /** Bearer token authorised to read the repo. */
    accessJwt: string;
    /** Whether this is the local agent's own repo. */
    isSelf: boolean;
}

export interface SyncOptions {
    pdsUrl: string;
    accessJwt: string;
    /** The local agent's own repo DID. */
    repo: string;
    /** Collections to sync (defaults to the native triple + tombstone). */
    collections?: string[];
    /** Max records per listRecords page. */
    pageSize?: number;
    /** Max pages per collection per repo. */
    maxPages?: number;
}

/** The native collections this language stores its convergence substrate in. */
export function nativeCollections(): string[] {
    return [TRIPLE_COLLECTION, TOMBSTONE_COLLECTION];
}

/**
 * List a repo collection fully (following the cursor) into ObservedRecords.
 * This is used only to obtain the *current* leaf set of a changed repo; the
 * convergence itself is the MST diff + OR-Set fold, not the pagination.
 */
async function listCollection(
    pdsUrl: string,
    accessJwt: string,
    repo: string,
    collection: string,
    pageSize: number,
    maxPages: number,
): Promise<ObservedRecord[]> {
    const out: ObservedRecord[] = [];
    let cursor: string | undefined = undefined;
    let pages = 0;
    while (pages < maxPages) {
        const res: Awaited<ReturnType<typeof xrpc.listRecords>> = await xrpc.listRecords(
            pdsUrl,
            accessJwt,
            repo,
            collection,
            cursor,
            pageSize,
        );
        if (!res || res.records.length === 0) break;
        for (const r of res.records) {
            const rkey = xrpc.rkeyFromUri(r.uri);
            out.push({ collection, rkey, value: r.value });
        }
        pages++;
        if (!res.cursor || res.records.length < pageSize) break;
        cursor = res.cursor;
    }
    return out;
}

/**
 * Sync a single repo: check its head commit CID, and only if it advanced,
 * diff its current record set against what we last ingested and ingest the
 * delta into the store at the new head. Returns true if anything changed.
 */
export async function syncRepo(target: RepoSyncTarget, opts: SyncOptions): Promise<boolean> {
    const collections = opts.collections ?? nativeCollections();
    const pageSize = opts.pageSize ?? 100;
    const maxPages = opts.maxPages ?? 50;

    // 1. Head check — the real content hash we ride.
    const latest = await xrpc.getLatestCommit(target.pdsUrl, target.did);
    if (!latest) return false;

    const lastHead = target.isSelf ? store.getLocalHead() : store.getPeerHead(target.did);
    if (lastHead && lastHead === latest.cid) {
        return false; // no new commits in this repo
    }

    // 2. Fetch the repo's current leaf set across native collections.
    const current: ObservedRecord[] = [];
    for (const collection of collections) {
        const recs = await listCollection(
            target.pdsUrl,
            target.accessJwt,
            target.did,
            collection,
            pageSize,
            maxPages,
        );
        current.push(...recs);
    }

    // 3. MST diff against the prior ingested state → delta.
    const priorEntries = target.isSelf
        ? store.localEntryCids()
        : store.peerEntryCids(target.did);
    const delta = diffRepoRecords(priorEntries, current);

    // 4. Ingest the delta at the new head.
    if (target.isSelf) {
        store.ingestSelfRecords(delta.puts, delta.deletePaths, latest.cid);
    } else {
        store.ingestPeerRecords(target.did, delta.puts, delta.deletePaths, latest.cid);
    }
    return delta.puts.length > 0 || delta.deletePaths.length > 0;
}

/**
 * Sync every participating repo (the local agent's own repo + all discovered
 * peer repos) and return the OR-Set convergence delta as a PerspectiveDiff.
 *
 * The delta is computed by folding the materialised link set before and after
 * the repo syncs and diffing — so it reflects true OR-Set convergence
 * (add-wins across repos, remove-wins on the observed hash), independent of
 * the order repos are folded in.
 */
export async function syncAll(opts: SyncOptions): Promise<PerspectiveDiff> {
    const before = snapshotLinks();

    const targets: RepoSyncTarget[] = [
        { did: opts.repo, pdsUrl: opts.pdsUrl, accessJwt: opts.accessJwt, isSelf: true },
    ];
    for (const did of store.listPeers("peers/")) {
        if (did === opts.repo) continue;
        targets.push({ did, pdsUrl: opts.pdsUrl, accessJwt: opts.accessJwt, isSelf: false });
    }

    for (const target of targets) {
        try {
            await syncRepo(target, opts);
        } catch (err) {
            console.error(`[atproto-sync] repo ${target.did} sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    return diffSnapshots(before, snapshotLinks());
}

// ---------------------------------------------------------------------------
// OR-Set convergence delta
// ---------------------------------------------------------------------------

/** Snapshot the materialised link set keyed by OR-Set hash. */
function snapshotLinks(): Map<string, LinkExpression> {
    const hashFn = getRuntime().hash;
    const map = new Map<string, LinkExpression>();
    for (const link of store.foldLinks()) {
        map.set(linkHash(link, hashFn), link);
    }
    return map;
}

/** Diff two link snapshots into a PerspectiveDiff (additions / removals). */
function diffSnapshots(
    before: Map<string, LinkExpression>,
    after: Map<string, LinkExpression>,
): PerspectiveDiff {
    const additions: LinkExpression[] = [];
    const removals: LinkExpression[] = [];
    for (const [h, link] of after) {
        if (!before.has(h)) additions.push(link);
    }
    for (const [h, link] of before) {
        if (!after.has(h)) removals.push(link);
    }
    return { additions, removals };
}
