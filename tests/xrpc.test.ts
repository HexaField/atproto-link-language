/**
 * Unit tests for XRPC request builders.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    tidFromTimestamp,
    tidFromISO,
    tidNow,
    buildCreateSessionRequest,
    buildRefreshSessionRequest,
    buildApplyWritesRequest,
    buildListRecordsRequest,
    buildGetRecordRequest,
    buildUploadBlobRequest,
    buildDeleteRecordRequest,
    buildResolveHandleRequest,
    buildCreateRecordRequest,
    parseSessionResponse,
    parseListRecordsResponse,
    parseGetRecordResponse,
    parseResolveHandleResponse,
    parseUploadBlobResponse,
    rkeyFromUri,
    collectionFromUri,
    buildAtUri,
    didFromUri,
} from "../src/xrpc.js";

// ---------------------------------------------------------------------------
// TID generation
// ---------------------------------------------------------------------------

describe("TID generation", () => {
    it("generates 13-character TIDs", () => {
        const tid = tidFromISO("2026-05-02T00:00:00.000Z");
        assert.equal(tid.length, 13);
    });

    it("generates different TIDs for different timestamps", () => {
        const tid1 = tidFromISO("2026-05-02T00:00:00.000Z");
        const tid2 = tidFromISO("2026-05-02T01:00:00.000Z");
        assert.notEqual(tid1, tid2);
    });

    it("generates consistent TIDs for the same timestamp", () => {
        const tid1 = tidFromISO("2026-05-02T00:00:00.000Z");
        const tid2 = tidFromISO("2026-05-02T00:00:00.000Z");
        assert.equal(tid1, tid2);
    });

    it("generates TIDs that sort chronologically", () => {
        const tid1 = tidFromISO("2026-05-02T00:00:00.000Z");
        const tid2 = tidFromISO("2026-05-02T01:00:00.000Z");
        const tid3 = tidFromISO("2026-05-03T00:00:00.000Z");
        assert.ok(tid1 < tid2, "tid1 should sort before tid2");
        assert.ok(tid2 < tid3, "tid2 should sort before tid3");
    });

    it("supports clock ID parameter", () => {
        const tid1 = tidFromISO("2026-05-02T00:00:00.000Z", 0);
        const tid2 = tidFromISO("2026-05-02T00:00:00.000Z", 1);
        assert.notEqual(tid1, tid2);
    });

    it("tidNow generates a valid TID", () => {
        const tid = tidNow();
        assert.equal(tid.length, 13);
        assert.ok(/^[234567a-z]{13}$/.test(tid));
    });

    it("uses only base32-sort characters", () => {
        const tid = tidFromISO("2026-05-02T12:34:56.789Z");
        assert.ok(/^[234567a-z]{13}$/.test(tid), `TID "${tid}" contains invalid characters`);
    });

    it("handles edge case timestamps", () => {
        const tid1 = tidFromISO("1970-01-01T00:00:00.000Z");
        assert.equal(tid1.length, 13);

        const tid2 = tidFromISO("2099-12-31T23:59:59.999Z");
        assert.equal(tid2.length, 13);

        assert.ok(tid1 < tid2);
    });

    // The canonical AT Protocol TID grammar a real PDS enforces for a record key
    // pinned `key: tid` (e.g. app.bsky.feed.post): 13 chars from the base32-sort
    // alphabet, first char restricted to [234567abcdefghij] (top bit clear).
    // See com.atproto.repo record-key validation.
    const AT_TID_RE = /^[234567abcdefghij][234567a-z]{12}$/;

    it("tidNow() is a valid AT-Protocol record-key TID (the Channel-B post rkey)", () => {
        // index.ts::projectPostsRoleB keys each projected app.bsky.feed.post with
        // `tidNow()`. app.bsky.feed.post's Lexicon pins `key: tid`, so a modern PDS
        // rejects any non-TID rkey. This guards that the generated rkey is a TID.
        for (let i = 0; i < 50; i++) {
            const rkey = tidNow();
            assert.ok(AT_TID_RE.test(rkey), `projected-post rkey "${rkey}" is not a valid AT TID`);
        }
    });

    it("a `bsky-`-prefixed rkey is NOT a valid TID (regression: the removed prefix)", () => {
        // Regression guard for the Role-B write defect: a `bsky-${tidNow()}` rkey
        // was rejected by the PDS with `InvalidRequest: Invalid record key for
        // app.bsky.feed.post: Invalid TID string`. Prove that historical form fails
        // the exact grammar, so the prefix is never reintroduced.
        assert.equal(AT_TID_RE.test(`bsky-${tidNow()}`), false);
    });
});

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

describe("buildCreateSessionRequest", () => {
    it("builds correct URL and body", () => {
        const req = buildCreateSessionRequest("https://pds.example.com", "alice.bsky.social", "password123");
        assert.equal(req.url, "https://pds.example.com/xrpc/com.atproto.server.createSession");
        assert.equal(req.method, "POST");
        assert.equal(req.headers["Content-Type"], "application/json");

        const body = JSON.parse(req.body);
        assert.equal(body.identifier, "alice.bsky.social");
        assert.equal(body.password, "password123");
    });
});

describe("buildRefreshSessionRequest", () => {
    it("includes Bearer authorization", () => {
        const req = buildRefreshSessionRequest("https://pds.example.com", "jwt-refresh-token");
        assert.equal(req.url, "https://pds.example.com/xrpc/com.atproto.server.refreshSession");
        assert.equal(req.headers["Authorization"], "Bearer jwt-refresh-token");
        assert.equal(req.method, "POST");
    });
});

describe("buildApplyWritesRequest", () => {
    it("includes writes array in body", () => {
        const writes = [
            {
                $type: "com.atproto.repo.applyWrites#create" as const,
                collection: "ad4m.link.triple",
                rkey: "abc123",
                value: { $type: "ad4m.link.triple", source: "s", predicate: "p", target: "t", author: "a", timestamp: "ts" },
            },
        ];
        const req = buildApplyWritesRequest("https://pds.example.com", "jwt", "did:plc:abc", writes);
        assert.equal(req.headers["Authorization"], "Bearer jwt");

        const body = JSON.parse(req.body);
        assert.equal(body.repo, "did:plc:abc");
        assert.equal(body.writes.length, 1);
    });
});

describe("buildListRecordsRequest", () => {
    it("includes repo and collection in URL params", () => {
        const req = buildListRecordsRequest("https://pds.example.com", "jwt", "did:plc:abc", "ad4m.link.triple");
        assert.ok(req.url.includes("repo=did%3Aplc%3Aabc"));
        assert.ok(req.url.includes("collection=ad4m.link.triple"));
        assert.ok(req.url.includes("limit=100"));
        assert.equal(req.method, "GET");
    });

    it("includes cursor when provided", () => {
        const req = buildListRecordsRequest("https://pds.example.com", "jwt", "did:plc:abc", "ad4m.link.triple", "cursor123", 50);
        assert.ok(req.url.includes("cursor=cursor123"));
        assert.ok(req.url.includes("limit=50"));
    });
});

describe("buildGetRecordRequest", () => {
    it("includes rkey in URL params", () => {
        const req = buildGetRecordRequest("https://pds.example.com", "jwt", "did:plc:abc", "ad4m.link.triple", "3k2abc");
        assert.ok(req.url.includes("rkey=3k2abc"));
        assert.equal(req.method, "GET");
    });
});

describe("buildUploadBlobRequest", () => {
    it("sets correct Content-Type", () => {
        const req = buildUploadBlobRequest("https://pds.example.com", "jwt", "image/png");
        assert.equal(req.headers["Content-Type"], "image/png");
        assert.equal(req.method, "POST");
    });
});

describe("buildDeleteRecordRequest", () => {
    it("includes collection and rkey in body", () => {
        const req = buildDeleteRecordRequest("https://pds.example.com", "jwt", "did:plc:abc", "ad4m.link.triple", "3k2abc");
        const body = JSON.parse(req.body);
        assert.equal(body.repo, "did:plc:abc");
        assert.equal(body.collection, "ad4m.link.triple");
        assert.equal(body.rkey, "3k2abc");
    });
});

describe("buildResolveHandleRequest", () => {
    it("includes handle in URL params", () => {
        const req = buildResolveHandleRequest("https://pds.example.com", "alice.bsky.social");
        assert.ok(req.url.includes("handle=alice.bsky.social"));
        assert.equal(req.method, "GET");
    });
});

describe("buildCreateRecordRequest", () => {
    it("includes record in body", () => {
        const record = { $type: "ad4m.link.triple", source: "s" };
        const req = buildCreateRecordRequest("https://pds.example.com", "jwt", "did:plc:abc", "ad4m.link.triple", "rkey1", record);
        const body = JSON.parse(req.body);
        assert.equal(body.collection, "ad4m.link.triple");
        assert.equal(body.rkey, "rkey1");
        assert.deepEqual(body.record, record);
    });
});

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

describe("parseSessionResponse", () => {
    it("parses valid session response", () => {
        const body = JSON.stringify({
            accessJwt: "access-token",
            refreshJwt: "refresh-token",
            did: "did:plc:abc123",
            handle: "alice.bsky.social",
        });
        const session = parseSessionResponse(body);
        assert.ok(session);
        assert.equal(session!.accessJwt, "access-token");
        assert.equal(session!.refreshJwt, "refresh-token");
        assert.equal(session!.did, "did:plc:abc123");
        assert.equal(session!.handle, "alice.bsky.social");
    });

    it("returns null for invalid response", () => {
        assert.equal(parseSessionResponse("{}"), null);
        assert.equal(parseSessionResponse("not json"), null);
        assert.equal(parseSessionResponse('{"accessJwt":"a"}'), null);
    });
});

describe("parseListRecordsResponse", () => {
    it("parses valid response with records", () => {
        const body = JSON.stringify({
            records: [
                { uri: "at://did:plc:abc/ad4m.link.triple/123", cid: "cid1", value: { $type: "ad4m.link.triple" } },
            ],
            cursor: "next-cursor",
        });
        const result = parseListRecordsResponse(body);
        assert.ok(result);
        assert.equal(result!.records.length, 1);
        assert.equal(result!.cursor, "next-cursor");
    });

    it("parses response without cursor", () => {
        const body = JSON.stringify({ records: [] });
        const result = parseListRecordsResponse(body);
        assert.ok(result);
        assert.equal(result!.records.length, 0);
        assert.equal(result!.cursor, undefined);
    });

    it("returns null for invalid response", () => {
        assert.equal(parseListRecordsResponse("not json"), null);
        assert.equal(parseListRecordsResponse("{}"), null);
    });
});

describe("parseGetRecordResponse", () => {
    it("parses valid response", () => {
        const body = JSON.stringify({
            uri: "at://did:plc:abc/ad4m.link.triple/123",
            cid: "cid1",
            value: { $type: "ad4m.link.triple", source: "s" },
        });
        const result = parseGetRecordResponse(body);
        assert.ok(result);
        assert.equal(result!.uri, "at://did:plc:abc/ad4m.link.triple/123");
    });

    it("returns null for missing fields", () => {
        assert.equal(parseGetRecordResponse('{"cid":"c"}'), null);
    });
});

describe("parseResolveHandleResponse", () => {
    it("parses valid response", () => {
        const result = parseResolveHandleResponse('{"did":"did:plc:abc123"}');
        assert.equal(result, "did:plc:abc123");
    });

    it("returns null for invalid response", () => {
        assert.equal(parseResolveHandleResponse("{}"), null);
        assert.equal(parseResolveHandleResponse("not json"), null);
    });
});

describe("parseUploadBlobResponse", () => {
    it("parses valid blob response", () => {
        const body = JSON.stringify({
            blob: { ref: { $link: "cid-link" }, mimeType: "image/png", size: 1024 },
        });
        const result = parseUploadBlobResponse(body);
        assert.ok(result);
        assert.equal(result!.ref.$link, "cid-link");
    });

    it("returns null for invalid response", () => {
        assert.equal(parseUploadBlobResponse("{}"), null);
    });
});

// ---------------------------------------------------------------------------
// URI helpers
// ---------------------------------------------------------------------------

describe("rkeyFromUri", () => {
    it("extracts rkey from AT URI", () => {
        assert.equal(rkeyFromUri("at://did:plc:abc/ad4m.link.triple/3k2abc"), "3k2abc");
    });

    it("handles URIs with multiple slashes", () => {
        assert.equal(rkeyFromUri("at://did:plc:abc/collection/rkey123"), "rkey123");
    });
});

describe("collectionFromUri", () => {
    it("extracts collection from AT URI", () => {
        assert.equal(collectionFromUri("at://did:plc:abc/ad4m.link.triple/3k2abc"), "ad4m.link.triple");
    });
});

describe("buildAtUri", () => {
    it("builds correct AT URI", () => {
        assert.equal(buildAtUri("did:plc:abc", "ad4m.link.triple", "3k2abc"), "at://did:plc:abc/ad4m.link.triple/3k2abc");
    });
});

describe("didFromUri", () => {
    it("extracts DID from AT URI", () => {
        assert.equal(didFromUri("at://did:plc:abc/ad4m.link.triple/3k2abc"), "did:plc:abc");
    });

    it("handles DID-only URI", () => {
        assert.equal(didFromUri("at://did:plc:abc"), "did:plc:abc");
    });
});
