/**
 * Unit tests for the MST commit-chain substrate.
 *
 * Covers the acceptance-criterion fixture requirement: an MST diff between two
 * commits yields exactly the records that changed. Also pins commit-CID and
 * MST-root determinism (the Merkle property the cross-repo convergence relies
 * on) and the signature-independence of the commit CID.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    emptyRepo,
    applyRecords,
    buildCommit,
    commitCid,
    mstRootCidFromMap,
    mstDiff,
    mstDiffMaps,
    recordCid,
    recordPath,
    splitPath,
    REPO_VERSION,
    type RepoRecord,
    type Commit,
} from "../src/mst.js";
import { isCommitCid } from "../src/cid.js";

const COLL = "ad4m.link.triple";

function rec(rkey: string, source: string): RepoRecord {
    return {
        collection: COLL,
        rkey,
        value: { $type: "ad4m.link.triple", source, predicate: "p", target: "t", author: "a", timestamp: "2026-05-02T00:00:00.000Z" },
    };
}

describe("paths", () => {
    it("recordPath and splitPath round-trip", () => {
        const p = recordPath(COLL, "abc");
        assert.equal(p, "ad4m.link.triple/abc");
        assert.deepEqual(splitPath(p), { collection: COLL, rkey: "abc" });
    });
});

describe("commit CID determinism", () => {
    it("identical record sets yield identical commit CIDs", () => {
        const a = emptyRepo("did:plc:x");
        const b = emptyRepo("did:plc:x");
        const ha = applyRecords(a, [rec("r1", "s1"), rec("r2", "s2")], []);
        const hb = applyRecords(b, [rec("r2", "s2"), rec("r1", "s1")], []); // inserted in different order
        assert.equal(ha, hb, "commit CID must be independent of record insertion order");
        assert.ok(isCommitCid(ha));
    });

    it("different DIDs yield different commit CIDs for the same records", () => {
        const a = emptyRepo("did:plc:x");
        const b = emptyRepo("did:plc:y");
        const ha = applyRecords(a, [rec("r1", "s1")], []);
        const hb = applyRecords(b, [rec("r1", "s1")], []);
        assert.notEqual(ha, hb);
    });

    it("the commit CID excludes the signature (covers the unsigned commit)", () => {
        const entries = new Map([[recordPath(COLL, "r1"), recordCid(rec("r1", "s1").value)]]);
        const data = mstRootCidFromMap(entries);
        const unsigned: Commit = { did: "did:plc:x", version: REPO_VERSION, prev: null, data };
        const signed: Commit = { ...unsigned, sig: "some-signature" };
        assert.equal(commitCid(unsigned), commitCid(signed), "sig must not change the commit CID");
    });

    it("buildCommit advances the CID as records change", () => {
        const entries = new Map<string, string>();
        entries.set(recordPath(COLL, "r1"), recordCid(rec("r1", "s1").value));
        const { cid: c1 } = buildCommit("did:plc:x", null, entries);
        entries.set(recordPath(COLL, "r2"), recordCid(rec("r2", "s2").value));
        const { cid: c2 } = buildCommit("did:plc:x", c1, entries);
        assert.notEqual(c1, c2);
    });
});

describe("MST root determinism", () => {
    it("the same leaf set yields the same root regardless of map order", () => {
        const m1 = new Map([
            [recordPath(COLL, "a"), recordCid(rec("a", "sa").value)],
            [recordPath(COLL, "b"), recordCid(rec("b", "sb").value)],
        ]);
        const m2 = new Map([...m1.entries()].reverse());
        assert.equal(mstRootCidFromMap(m1), mstRootCidFromMap(m2));
    });
});

describe("MST diff between two commits", () => {
    it("yields exactly the added leaf when one record is appended", () => {
        const repo = emptyRepo("did:plc:x");
        applyRecords(repo, [rec("r1", "s1")], []);
        const prev = new Map(repo.entries);

        applyRecords(repo, [rec("r2", "s2")], []);
        const diff = mstDiffMaps(prev, repo.entries, repo.blocks);

        assert.equal(diff.added.length, 1);
        assert.equal(diff.added[0].rkey, "r2");
        assert.equal((diff.added[0].value as Record<string, unknown>).source, "s2");
        assert.equal(diff.removed.length, 0);
        assert.equal(diff.updated.length, 0);
    });

    it("yields exactly the removed leaf when a record is deleted", () => {
        const repo = emptyRepo("did:plc:x");
        applyRecords(repo, [rec("r1", "s1"), rec("r2", "s2")], []);
        const prev = new Map(repo.entries);

        applyRecords(repo, [], [recordPath(COLL, "r1")]);
        const diff = mstDiffMaps(prev, repo.entries, repo.blocks);

        assert.equal(diff.removed.length, 1);
        assert.equal(diff.removed[0].rkey, "r1");
        assert.equal(diff.added.length, 0);
    });

    it("yields exactly the updated leaf when a record's content changes at the same path", () => {
        const prevRepo = emptyRepo("did:plc:x");
        applyRecords(prevRepo, [rec("r1", "old")], []);
        const nextRepo = emptyRepo("did:plc:x");
        applyRecords(nextRepo, [rec("r1", "new")], []);

        const diff = mstDiff(prevRepo, nextRepo);
        assert.equal(diff.updated.length, 1);
        assert.equal(diff.updated[0].rkey, "r1");
        assert.equal((diff.updated[0].value as Record<string, unknown>).source, "new");
        assert.equal(diff.added.length, 0);
        assert.equal(diff.removed.length, 0);
    });

    it("reports no changes between identical commits", () => {
        const repo = emptyRepo("did:plc:x");
        applyRecords(repo, [rec("r1", "s1")], []);
        const diff = mstDiffMaps(new Map(repo.entries), repo.entries, repo.blocks);
        assert.equal(diff.added.length, 0);
        assert.equal(diff.removed.length, 0);
        assert.equal(diff.updated.length, 0);
    });
});
