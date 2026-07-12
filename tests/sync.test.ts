/**
 * Unit tests for the MST-diff sync layer.
 *
 * The unit of sync is a repo *commit head* (a real content hash), not a
 * listRecords cursor. These tests cover:
 *   - the pure record-level MST diff (`diffRepoRecords`),
 *   - `syncRepo` riding a repo's `getLatestCommit` head + skipping unchanged
 *     heads,
 *   - `syncAll` folding self + peer repos into the OR-Set convergence delta.
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
import { diffRepoRecords, syncAll, syncRepo, type ObservedRecord } from "../src/sync.js";
import { recordCid, recordPath } from "../src/mst.js";
import { TRIPLE_COLLECTION, TOMBSTONE_COLLECTION } from "../src/lexicon.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock Adapters
// ---------------------------------------------------------------------------

class MockStorage implements StorageAdapter {
    private data = new Map<string, string>();
    get(key: string) { return this.data.get(key) ?? null; }
    put(key: string, value: string) { this.data.set(key, value); }
    delete(key: string) { this.data.delete(key); }
    listKeys(prefix?: string) {
        const all = [...this.data.keys()];
        return prefix ? all.filter(k => k.startsWith(prefix)) : all;
    }
    _clear() { this.data.clear(); }
}

class MockTransport implements Transport {
    private responses = new Map<string, TransportResponse>();
    public requests: Array<{ url: string; method: string }> = [];

    addResponse(urlMatch: string, response: TransportResponse) {
        this.responses.set(urlMatch, response);
    }

    async fetch(url: string, method: string): Promise<TransportResponse> {
        this.requests.push({ url, method });
        for (const [match, response] of this.responses) {
            if (url.includes(match)) return response;
        }
        return { status: 404, headers: {}, body: '{"error":"not found"}' };
    }
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

class MockRuntime implements RuntimeAdapter {
    hash(data: string) { return simpleHash(data); }
    emitSignal() {}
    emitPerspectiveDiff() {}
}

class MockSigning implements SigningAdapter {
    signStringHex() { return "mock-sig"; }
    signingKeyId() { return "mock-key"; }
}

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

let mockStorage: MockStorage;
let mockTransport: MockTransport;

beforeEach(() => {
    mockStorage = new MockStorage();
    mockTransport = new MockTransport();
    initStorage(mockStorage);
    initTransport(mockTransport);
    initRuntime(new MockRuntime());
    initSigning(new MockSigning());
    store.initStore(simpleHash);
});

function tripleRecord(source: string, author = "did:key:z6Mk1", timestamp = "2026-05-02T00:00:00.000Z") {
    return {
        $type: "ad4m.link.triple",
        source,
        predicate: "sioc://content_of",
        target: "literal://world",
        author,
        timestamp,
    };
}

function observed(collection: string, rkey: string, value: Record<string, unknown>): ObservedRecord {
    return { collection, rkey, value };
}

/** Wire a repo's head + per-collection record listings into the mock. */
function wireRepo(head: string, tripleRecords: unknown[], tombstoneRecords: unknown[] = []) {
    mockTransport.addResponse("com.atproto.sync.getLatestCommit", {
        status: 200,
        headers: {},
        body: JSON.stringify({ cid: head, rev: "3kaaa" }),
    });
    mockTransport.addResponse("collection=ad4m.link.triple", {
        status: 200,
        headers: {},
        body: JSON.stringify({ records: tripleRecords }),
    });
    mockTransport.addResponse("collection=ad4m.link.tombstone", {
        status: 200,
        headers: {},
        body: JSON.stringify({ records: tombstoneRecords }),
    });
}

// ---------------------------------------------------------------------------
// diffRepoRecords — the pure MST-diff core
// ---------------------------------------------------------------------------

describe("diffRepoRecords", () => {
    it("reports every record as a put when the prior state is empty", () => {
        const current = [observed(TRIPLE_COLLECTION, "r1", tripleRecord("s1"))];
        const delta = diffRepoRecords(new Map(), current);
        assert.equal(delta.puts.length, 1);
        assert.equal(delta.deletePaths.length, 0);
    });

    it("reports no change when the record CIDs are unchanged", () => {
        const rec = tripleRecord("s1");
        const path = recordPath(TRIPLE_COLLECTION, "r1");
        const prior = new Map([[path, recordCid(rec)]]);
        const delta = diffRepoRecords(prior, [observed(TRIPLE_COLLECTION, "r1", rec)]);
        assert.equal(delta.puts.length, 0);
        assert.equal(delta.deletePaths.length, 0);
    });

    it("reports a put when a record's content changed at the same path", () => {
        const path = recordPath(TRIPLE_COLLECTION, "r1");
        const prior = new Map([[path, recordCid(tripleRecord("old"))]]);
        const delta = diffRepoRecords(prior, [observed(TRIPLE_COLLECTION, "r1", tripleRecord("new"))]);
        assert.equal(delta.puts.length, 1);
        assert.equal((delta.puts[0].value as Record<string, unknown>).source, "new");
    });

    it("reports a delete when a prior path disappears from the current set", () => {
        const path = recordPath(TRIPLE_COLLECTION, "gone");
        const prior = new Map([[path, recordCid(tripleRecord("s1"))]]);
        const delta = diffRepoRecords(prior, []);
        assert.deepEqual(delta.deletePaths, [path]);
        assert.equal(delta.puts.length, 0);
    });
});

// ---------------------------------------------------------------------------
// syncRepo — ride a repo head
// ---------------------------------------------------------------------------

describe("syncRepo", () => {
    it("ingests a peer repo's records and adopts its commit CID as head", async () => {
        wireRepo("bafypeerhead", [
            { uri: "at://did:plc:peer/ad4m.link.triple/r1", cid: "c1", value: tripleRecord("remote://s") },
        ]);

        const changed = await syncRepo(
            { did: "did:plc:peer", pdsUrl: "https://pds", accessJwt: "jwt", isSelf: false },
            { pdsUrl: "https://pds", accessJwt: "jwt", repo: "did:plc:self" },
        );

        assert.equal(changed, true);
        assert.equal(store.getPeerHead("did:plc:peer"), "bafypeerhead");
        assert.equal(store.foldLinks().length, 1);
    });

    it("returns false and re-fetches nothing when the head is unchanged", async () => {
        wireRepo("bafystable", [
            { uri: "at://did:plc:peer/ad4m.link.triple/r1", cid: "c1", value: tripleRecord("remote://s") },
        ]);
        const target = { did: "did:plc:peer", pdsUrl: "https://pds", accessJwt: "jwt", isSelf: false };
        const opts = { pdsUrl: "https://pds", accessJwt: "jwt", repo: "did:plc:self" };

        await syncRepo(target, opts);
        const before = mockTransport.requests.length;

        const changed = await syncRepo(target, opts);
        assert.equal(changed, false);
        const after = mockTransport.requests.slice(before);
        assert.ok(after.every(r => !r.url.includes("listRecords")), "unchanged head → no listRecords");
    });
});

// ---------------------------------------------------------------------------
// syncAll — cross-repo OR-Set convergence delta
// ---------------------------------------------------------------------------

describe("syncAll", () => {
    it("returns an empty diff when the self repo has no records", async () => {
        wireRepo("bafyempty", []);
        const diff = await syncAll({ pdsUrl: "https://pds", accessJwt: "jwt", repo: "did:plc:self" });
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });

    it("materialises self-repo records as additions", async () => {
        wireRepo("bafyself", [
            { uri: "at://did:plc:self/ad4m.link.triple/r1", cid: "c1", value: tripleRecord("literal://hello") },
        ]);
        const diff = await syncAll({ pdsUrl: "https://pds", accessJwt: "jwt", repo: "did:plc:self" });
        assert.equal(diff.additions.length, 1);
        assert.equal(diff.additions[0].data.source, "literal://hello");
        // Self head adopted from the PDS.
        assert.equal(store.getLocalHead(), "bafyself");
    });

    it("handles transport errors gracefully (empty diff, no throw)", async () => {
        mockTransport.addResponse("com.atproto.sync.getLatestCommit", {
            status: 500,
            headers: {},
            body: '{"error":"internal"}',
        });
        const diff = await syncAll({ pdsUrl: "https://pds", accessJwt: "jwt", repo: "did:plc:self" });
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });
});
