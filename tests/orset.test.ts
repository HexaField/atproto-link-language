/**
 * Unit tests for the cross-repo OR-Set and the version-vector digest.
 *
 * The OR-Set is the multi-agent convergence core: present = ⋃adds \ ⋃tombstones,
 * order-independent by set algebra. The version-vector digest is the
 * multi-writer `currentRevision()` when there is no single head.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { foldOrSet, versionVectorDigest, emptyContribution, type RepoContribution } from "../src/orset.js";

function contrib(adds: string[], tombstones: string[] = []): RepoContribution {
    return { adds: new Set(adds), tombstones: new Set(tombstones) };
}

function hashFn(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    return "b" + (h >>> 0).toString(16);
}

describe("foldOrSet", () => {
    it("an empty fold has an empty present set", () => {
        const r = foldOrSet([emptyContribution()]);
        assert.equal(r.present.size, 0);
    });

    it("present = union of adds minus union of tombstones", () => {
        const r = foldOrSet([contrib(["h1", "h2"]), contrib(["h3"], ["h2"])]);
        assert.deepEqual([...r.present].sort(), ["h1", "h3"]);
        assert.deepEqual([...r.allAdds].sort(), ["h1", "h2", "h3"]);
        assert.deepEqual([...r.allTombstones].sort(), ["h2"]);
    });

    it("a tombstone in one repo removes an add in another (cross-repo removal)", () => {
        const add = contrib(["hX"]);
        const remove = contrib([], ["hX"]);
        assert.equal(foldOrSet([add, remove]).present.has("hX"), false);
    });

    it("is order-independent (set algebra commutes/associates)", () => {
        const a = contrib(["h1", "h2"], ["h3"]);
        const b = contrib(["h3", "h4"]);
        const c = contrib([], ["h4"]);
        const abc = [...foldOrSet([a, b, c]).present].sort();
        const cba = [...foldOrSet([c, b, a]).present].sort();
        const bac = [...foldOrSet([b, a, c]).present].sort();
        assert.deepEqual(abc, cba);
        assert.deepEqual(abc, bac);
    });

    it("remove-wins even when the same hash is re-added elsewhere", () => {
        // Observed-remove semantics: the tombstone removes the observed hash.
        const present = foldOrSet([contrib(["h"]), contrib(["h"], ["h"])]).present;
        assert.equal(present.has("h"), false);
    });
});

describe("versionVectorDigest", () => {
    it("is empty for no heads", () => {
        assert.equal(versionVectorDigest(new Map(), hashFn), "");
    });

    it("is the single commit CID when there is exactly one head", () => {
        assert.equal(versionVectorDigest(new Map([["did:a", "bafyA"]]), hashFn), "bafyA");
    });

    it("is a stable hash of the sorted head set for multiple writers", () => {
        const h1 = versionVectorDigest(new Map([["did:a", "bafyA"], ["did:b", "bafyB"]]), hashFn);
        const h2 = versionVectorDigest(new Map([["did:b", "bafyB"], ["did:a", "bafyA"]]), hashFn);
        assert.equal(h1, h2, "digest must be independent of head insertion order");
        assert.ok(h1.length > 0);
    });

    it("changes when any head advances", () => {
        const before = versionVectorDigest(new Map([["did:a", "bafyA"], ["did:b", "bafyB1"]]), hashFn);
        const after = versionVectorDigest(new Map([["did:a", "bafyA"], ["did:b", "bafyB2"]]), hashFn);
        assert.notEqual(before, after);
    });

    it("ignores writers with an empty head", () => {
        const withEmpty = versionVectorDigest(new Map([["did:a", "bafyA"], ["did:b", ""]]), hashFn);
        const withoutEmpty = versionVectorDigest(new Map([["did:a", "bafyA"]]), hashFn);
        assert.equal(withEmpty, withoutEmpty);
    });
});
