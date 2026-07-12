/**
 * Acceptance-criteria regression tests for the diff-DAG convergence rework
 * (SPEC_LINK_LANGUAGE_DIFFDAG_CONVERGENCE.md §5), specialised for atproto:
 * ride the MST commit chain, converge multi-agent via the cross-repo OR-Set.
 *
 * These are the tests that would have caught the fakes the rework removes:
 *   §5.1  currentRevision() is a content hash (commit CID / version-vector
 *         digest) that changes deterministically with committed content and is
 *         stable across restarts for the same state — NOT a listRecords cursor.
 *   §5.2  the DAG (repo commit chain) is authoritative: folding the substrate
 *         from genesis reproduces the materialised link set.
 *   §5.3  removals converge cross-repo: A adds L (hash h), B tombstones h →
 *         L absent on both; add-after-remove re-adds; order-independent.
 *   §5.4  merge is order-independent: folding repos {A,B} in either order
 *         yields the same revision digest and the same link set.
 *   §5.5  Role B (render) is derived by folding the substrate, never read back.
 *
 * Everything here is pure (no live PDS): the CID/commit math, the MST diff and
 * the OR-Set fold. Cross-agent wire transport needs a live PDS/federation —
 * see README "What needs a live PDS".
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/adapters.js";
import { initStorage } from "../src/adapters.js";
import type { Transport, TransportResponse } from "../src/adapters.js";
import { initTransport } from "../src/adapters.js";
import type { RuntimeAdapter } from "../src/adapters.js";
import { initRuntime } from "../src/adapters.js";
import { initSigning } from "../src/adapters.js";
import type { SigningAdapter } from "../src/adapters.js";

import * as store from "../src/store.js";
import { linkHash, linkToTripleRecord, linkToTombstoneRecord } from "../src/translate.js";
import { emptyRepo, applyRecords, recordPath, type RepoRecord } from "../src/mst.js";
import { foldOrSet, versionVectorDigest, type RepoContribution } from "../src/orset.js";
import { cidForValue, isCommitCid } from "../src/cid.js";
import { TRIPLE_COLLECTION, TOMBSTONE_COLLECTION } from "../src/lexicon.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks (in-memory KV, no transport needed)
// ---------------------------------------------------------------------------

class MockStorage implements StorageAdapter {
    public data = new Map<string, string>();
    get(key: string) { return this.data.get(key) ?? null; }
    put(key: string, value: string) { this.data.set(key, value); }
    delete(key: string) { this.data.delete(key); }
    listKeys(prefix?: string) {
        const all = [...this.data.keys()];
        return prefix ? all.filter(k => k.startsWith(prefix)) : all;
    }
}

class NullTransport implements Transport {
    async fetch(): Promise<TransportResponse> {
        return { status: 404, headers: {}, body: "{}" };
    }
}

/**
 * A real content hash for the test runtime: sha-256-style avalanche over the
 * input (FNV-1a-ish), hex-encoded. Distinct inputs give distinct digests, so
 * the OR-Set element keys and version-vector digest behave like production.
 */
function testHash(data: string): string {
    let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
    for (let i = 0; i < data.length; i++) {
        const c = data.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    }
    return "b" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

class MockRuntime implements RuntimeAdapter {
    hash(data: string) { return testHash(data); }
    emitSignal() {}
    emitPerspectiveDiff() {}
}

class MockSigning implements SigningAdapter {
    signStringHex() { return "sig"; }
    signingKeyId() { return "key"; }
}

let mockStorage: MockStorage;

beforeEach(() => {
    mockStorage = new MockStorage();
    initStorage(mockStorage);
    initTransport(new NullTransport());
    initRuntime(new MockRuntime());
    initSigning(new MockSigning());
    store.initStore(testHash);
});

function makeLink(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkAlice",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: { source: "literal://hello", predicate: "sioc://content_of", target: "literal://world" },
        proof: { signature: "", key: "" },
        ...overrides,
    };
}

/** Build a peer repo's records (adds as triples, removals as tombstones). */
function repoRecords(adds: LinkExpression[], removes: LinkExpression[]): RepoRecord[] {
    const recs: RepoRecord[] = [];
    for (const l of adds) {
        recs.push({ collection: TRIPLE_COLLECTION, rkey: linkHash(l, testHash), value: linkToTripleRecord(l) as unknown as Record<string, unknown> });
    }
    for (const l of removes) {
        const t = linkToTombstoneRecord(l, testHash);
        recs.push({ collection: TOMBSTONE_COLLECTION, rkey: t.linkHash, value: t as unknown as Record<string, unknown> });
    }
    return recs;
}

// ===========================================================================
// §5.1 — currentRevision() is a content hash
// ===========================================================================

describe("§5.1 currentRevision is a content hash", () => {
    it("is empty before any commit, a real commit CID after", () => {
        assert.equal(store.getRevision(), "");
        store.setLocalDid("did:plc:self");
        store.applyLocalDiff({ additions: [makeLink()], removals: [] });
        const rev = store.getRevision();
        assert.ok(rev.length > 0);
        // Solo: the revision IS the local commit CID, and it is a real CIDv1.
        assert.equal(rev, store.getLocalHead());
        assert.ok(isCommitCid(rev), `revision ${rev} should be a CIDv1 commit hash`);
    });

    it("changes deterministically as committed content advances", () => {
        store.setLocalDid("did:plc:self");
        store.applyLocalDiff({ additions: [makeLink({ data: { source: "a", predicate: "p", target: "t" } })], removals: [] });
        const r1 = store.getRevision();
        store.applyLocalDiff({ additions: [makeLink({ data: { source: "b", predicate: "p", target: "t" } })], removals: [] });
        const r2 = store.getRevision();
        assert.notEqual(r1, r2, "revision must advance when content changes");
    });

    it("is stable across a restart for the same materialised state", () => {
        store.setLocalDid("did:plc:self");
        store.applyLocalDiff({ additions: [makeLink()], removals: [] });
        const revBefore = store.getRevision();

        // Simulate a restart: fresh module state, same persisted KV.
        store.initStore(testHash);
        const revAfter = store.getRevision();

        assert.equal(revAfter, revBefore, "revision must be stable across restarts for the same state");
    });

    it("is NOT a listRecords cursor (no cursor key participates)", () => {
        store.setLocalDid("did:plc:self");
        store.applyLocalDiff({ additions: [makeLink()], removals: [] });
        // The revision is derived purely from the commit head — assert no legacy
        // cursor key exists in KV, and the revision equals the commit CID.
        assert.equal(mockStorage.get("at:sync:cursor"), null);
        assert.equal(store.getRevision(), store.getLocalHead());
    });
});

// ===========================================================================
// §5.2 — the DAG is authoritative (fold from genesis reproduces the set)
// ===========================================================================

describe("§5.2 DAG is authoritative", () => {
    it("folding the substrate reproduces the materialised link set", () => {
        store.setLocalDid("did:plc:self");
        const l1 = makeLink({ data: { source: "s1", predicate: "p", target: "t1" } });
        const l2 = makeLink({ data: { source: "s2", predicate: "p", target: "t2" } });
        store.applyLocalDiff({ additions: [l1, l2], removals: [] });

        // Independently fold the SAME records from genesis in a bare RepoState
        // (no KV cache) and assert the present set matches store.foldLinks().
        const bare = emptyRepo("did:plc:self");
        applyRecords(bare, repoRecords([l1, l2], []), []);
        const folded = new Set<string>();
        for (const [, cid] of bare.entries) {
            const v = bare.blocks.get(cid)!;
            folded.add(v.source as string);
        }
        const cacheSources = new Set(store.foldLinks().map(l => l.data.source));
        assert.deepEqual([...cacheSources].sort(), [...folded].sort());
    });

    it("a tombstone in the fold removes the add keyed by the same hash", () => {
        store.setLocalDid("did:plc:self");
        const l = makeLink();
        store.applyLocalDiff({ additions: [l], removals: [] });
        assert.equal(store.foldLinks().length, 1);
        store.applyLocalDiff({ additions: [], removals: [l] });
        assert.equal(store.foldLinks().length, 0, "tombstone must remove the folded link");
    });
});

// ===========================================================================
// §5.3 — removals converge cross-repo (OR-Set)
// ===========================================================================

describe("§5.3 removals converge (cross-repo OR-Set)", () => {
    it("A adds L, B tombstones h → L absent after fold, on both", () => {
        const L = makeLink();
        const h = linkHash(L, testHash);

        // Two repos: A holds the add, B holds the tombstone for the same hash.
        const contribA: RepoContribution = { adds: new Set([h]), tombstones: new Set() };
        const contribB: RepoContribution = { adds: new Set(), tombstones: new Set([h]) };

        // Both agents fold the union of both repos → identical result.
        const foldedAtA = foldOrSet([contribA, contribB]);
        const foldedAtB = foldOrSet([contribB, contribA]);
        assert.equal(foldedAtA.present.has(h), false, "L must be absent at agent A");
        assert.equal(foldedAtB.present.has(h), false, "L must be absent at agent B");
        assert.deepEqual([...foldedAtA.present], [...foldedAtB.present]);
    });

    it("cross-repo removal converges end-to-end through the store", () => {
        // Local repo adds L; a peer repo carries the tombstone for the same hash.
        store.setLocalDid("did:plc:self");
        const L = makeLink();
        store.applyLocalDiff({ additions: [L], removals: [] });
        assert.equal(store.foldLinks().length, 1);

        const tomb = linkToTombstoneRecord(L, testHash);
        store.ingestPeerRecords(
            "did:plc:peer",
            [{ collection: TOMBSTONE_COLLECTION, rkey: tomb.linkHash, value: tomb as unknown as Record<string, unknown> }],
            [],
            "bafypeer",
        );
        assert.equal(store.foldLinks().length, 0, "peer's tombstone must remove the local add");
    });

    it("add-after-remove re-adds via a new link (new timestamp ⇒ new hash)", () => {
        const L = makeLink({ timestamp: "2026-05-02T00:00:00.000Z" });
        const L2 = makeLink({ timestamp: "2026-05-02T00:00:05.000Z" }); // re-assert later
        const h = linkHash(L, testHash);
        const h2 = linkHash(L2, testHash);
        assert.notEqual(h, h2, "re-asserted link has a distinct OR-Set hash");

        const present = foldOrSet([
            { adds: new Set([h, h2]), tombstones: new Set([h]) },
        ]).present;
        assert.equal(present.has(h), false, "the old tombstoned hash stays removed");
        assert.equal(present.has(h2), true, "the re-asserted link is present");
    });

    it("concurrent add+remove of the same hash resolves remove-wins deterministically", () => {
        const L = makeLink();
        const h = linkHash(L, testHash);
        // Same hash added in one repo and tombstoned in another, concurrently.
        const present = foldOrSet([
            { adds: new Set([h]), tombstones: new Set() },
            { adds: new Set([h]), tombstones: new Set([h]) },
        ]).present;
        assert.equal(present.has(h), false, "observed-remove wins on the observed hash");
    });
});

// ===========================================================================
// §5.4 — merge is order-independent
// ===========================================================================

describe("§5.4 merge is order-independent", () => {
    it("folding repos {A,B} in either order yields the same present set", () => {
        const la = makeLink({ data: { source: "a", predicate: "p", target: "t" } });
        const lb = makeLink({ data: { source: "b", predicate: "p", target: "t" } });
        const ha = linkHash(la, testHash), hb = linkHash(lb, testHash);
        const A: RepoContribution = { adds: new Set([ha]), tombstones: new Set([hb]) };
        const B: RepoContribution = { adds: new Set([hb, ha]), tombstones: new Set() };

        const ab = foldOrSet([A, B]).present;
        const ba = foldOrSet([B, A]).present;
        assert.deepEqual([...ab].sort(), [...ba].sort());
    });

    it("version-vector digest is independent of head insertion order", () => {
        const heads1 = new Map([["did:plc:a", "bafyA"], ["did:plc:b", "bafyB"], ["did:plc:c", "bafyC"]]);
        const heads2 = new Map([["did:plc:c", "bafyC"], ["did:plc:a", "bafyA"], ["did:plc:b", "bafyB"]]);
        assert.equal(versionVectorDigest(heads1, testHash), versionVectorDigest(heads2, testHash));
    });

    it("applying two diffs in either order yields the same revision digest", () => {
        const la = makeLink({ data: { source: "a", predicate: "p", target: "t" } });
        const lb = makeLink({ data: { source: "b", predicate: "p", target: "t" } });

        // Order 1: a then b, folded across two peer repos.
        initStorage(new MockStorage());
        store.initStore(testHash);
        store.ingestPeerRecords("did:plc:a", repoRecords([la], []), [], "bafyA");
        store.ingestPeerRecords("did:plc:b", repoRecords([lb], []), [], "bafyB");
        const rev1 = store.getRevision();
        const set1 = new Set(store.foldLinks().map(l => l.data.source));

        // Order 2: b then a.
        initStorage(new MockStorage());
        store.initStore(testHash);
        store.ingestPeerRecords("did:plc:b", repoRecords([lb], []), [], "bafyB");
        store.ingestPeerRecords("did:plc:a", repoRecords([la], []), [], "bafyA");
        const rev2 = store.getRevision();
        const set2 = new Set(store.foldLinks().map(l => l.data.source));

        assert.equal(rev1, rev2, "revision digest must be order-independent");
        assert.deepEqual([...set1].sort(), [...set2].sort());
    });
});

// ===========================================================================
// §5.5 — Role B (render) is derived by folding the substrate
// ===========================================================================

describe("§5.5 Role B render is derived from the fold", () => {
    it("render (allLinks) equals the substrate fold, not a separate store", () => {
        store.setLocalDid("did:plc:self");
        const l1 = makeLink({ data: { source: "s1", predicate: "p", target: "t1" } });
        const l2 = makeLink({ data: { source: "s2", predicate: "p", target: "t2" } });
        store.applyLocalDiff({ additions: [l1, l2], removals: [] });

        const rendered = new Set(store.allLinks().links.map(l => l.data.source));
        const folded = new Set(store.foldLinks().map(l => l.data.source));
        assert.deepEqual([...rendered].sort(), [...folded].sort());
    });
});

// ===========================================================================
// Commit-CID sanity (the MST math the revision rides)
// ===========================================================================

describe("commit CID math", () => {
    it("the same record set yields the same commit CID (Merkle determinism)", () => {
        const l = makeLink();
        const recs = repoRecords([l], []);

        const r1 = emptyRepo("did:plc:self");
        const head1 = applyRecords(r1, recs, []);
        const r2 = emptyRepo("did:plc:self");
        const head2 = applyRecords(r2, recs, []);
        assert.equal(head1, head2, "identical record set ⇒ identical commit CID");
        assert.ok(isCommitCid(head1));
    });

    it("a record's CID is a real CIDv1 dag-cbor hash", () => {
        const cid = cidForValue(linkToTripleRecord(makeLink()) as unknown as Record<string, unknown>);
        assert.ok(isCommitCid(cid), `${cid} should be a CIDv1`);
    });
});
