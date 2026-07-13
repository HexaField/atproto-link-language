/**
 * Unit tests for Link ↔ AT Proto record translation.
 *
 * Tests pure translation functions without ad4m:host runtime.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    linkToTripleRecord,
    tripleRecordToLink,
    blueskyPostToLink,
    blueskyLikeToLink,
    blueskyRepostToLink,
    blueskyFollowToLink,
    linkToBlueskyPost,
    linkToBlueskyLike,
    linkToBlueskyRepost,
    linkToRkey,
    diffToWriteOps,
    recordToLink,
    linkContentKey,
    isTripleRecord,
    isBlueskyPost,
} from "../src/translate.js";

import type {
    LinkExpression,
    PerspectiveDiff,
    Ad4mLinkTriple,
    BskyPost,
    BskyLike,
    BskyRepost,
    BskyFollow,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLinkExpression(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "literal://hello",
            target: "literal://world",
            predicate: "sioc://content_of",
        },
        proof: {
            signature: "abc123",
            key: "key123",
        },
        ...overrides,
    };
}

function makeChatLink(): LinkExpression {
    return makeLinkExpression({
        data: {
            source: "channel://main",
            target: "expr://msg-001",
            predicate: "flux://has_message",
        },
    });
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

// ---------------------------------------------------------------------------
// linkToTripleRecord
// ---------------------------------------------------------------------------

describe("linkToTripleRecord", () => {
    it("converts a LinkExpression to an ad4m.link.triple record", () => {
        const link = makeLinkExpression();
        const record = linkToTripleRecord(link);

        assert.equal(record.$type, "ad4m.link.triple");
        assert.equal(record.source, "literal://hello");
        assert.equal(record.predicate, "sioc://content_of");
        assert.equal(record.target, "literal://world");
        assert.equal(record.author, "did:key:z6MkTest");
        assert.equal(record.timestamp, "2026-05-02T00:00:00.000Z");
        assert.deepEqual(record.proof, { signature: "abc123", key: "key123" });
    });

    it("handles links without proof", () => {
        const link = makeLinkExpression({
            proof: { signature: "", key: "" },
        });
        const record = linkToTripleRecord(link);
        assert.equal(record.proof, undefined);
    });

    it("handles links with empty source/predicate/target", () => {
        const link = makeLinkExpression({
            data: { source: "", target: "", predicate: "" },
        });
        const record = linkToTripleRecord(link);
        assert.equal(record.source, "");
        assert.equal(record.predicate, "");
        assert.equal(record.target, "");
    });
});

// ---------------------------------------------------------------------------
// tripleRecordToLink
// ---------------------------------------------------------------------------

describe("tripleRecordToLink", () => {
    it("converts an ad4m.link.triple record to a LinkExpression", () => {
        const record: Ad4mLinkTriple = {
            $type: "ad4m.link.triple",
            source: "literal://hello",
            predicate: "sioc://content_of",
            target: "literal://world",
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:00:00.000Z",
            proof: { signature: "abc123", key: "key123" },
        };

        const link = tripleRecordToLink(record);
        assert.equal(link.author, "did:key:z6MkTest");
        assert.equal(link.timestamp, "2026-05-02T00:00:00.000Z");
        assert.equal(link.data.source, "literal://hello");
        assert.equal(link.data.predicate, "sioc://content_of");
        assert.equal(link.data.target, "literal://world");
        assert.deepEqual(link.proof, { signature: "abc123", key: "key123" });
    });

    it("handles records without proof", () => {
        const record: Ad4mLinkTriple = {
            $type: "ad4m.link.triple",
            source: "a",
            predicate: "b",
            target: "c",
            author: "did:key:z6Mk1",
            timestamp: "2026-05-02T00:00:00.000Z",
        };

        const link = tripleRecordToLink(record);
        assert.deepEqual(link.proof, { signature: "", key: "" });
    });
});

// ---------------------------------------------------------------------------
// Round-trip: link → triple record → link
// ---------------------------------------------------------------------------

describe("round-trip: link → triple → link", () => {
    it("is lossless for a full LinkExpression", () => {
        const original = makeLinkExpression();
        const record = linkToTripleRecord(original);
        const reconstructed = tripleRecordToLink(record);

        assert.equal(reconstructed.author, original.author);
        assert.equal(reconstructed.timestamp, original.timestamp);
        assert.equal(reconstructed.data.source, original.data.source);
        assert.equal(reconstructed.data.predicate, original.data.predicate);
        assert.equal(reconstructed.data.target, original.data.target);
        assert.deepEqual(reconstructed.proof, original.proof);
    });

    it("is lossless for a link with special characters", () => {
        const original = makeLinkExpression({
            data: {
                source: "literal://hello%20world",
                predicate: "flux://has_message",
                target: 'literal://{"text":"hello","emoji":"🎉"}',
            },
        });
        const record = linkToTripleRecord(original);
        const reconstructed = tripleRecordToLink(record);

        assert.equal(reconstructed.data.source, original.data.source);
        assert.equal(reconstructed.data.target, original.data.target);
    });

    it("preserves proof through round-trip", () => {
        const original = makeLinkExpression({
            proof: { signature: "sig_xyz_789", key: "key_abc_123" },
        });
        const record = linkToTripleRecord(original);
        const reconstructed = tripleRecordToLink(record);

        assert.equal(reconstructed.proof.signature, "sig_xyz_789");
        assert.equal(reconstructed.proof.key, "key_abc_123");
    });

    it("handles multiple round-trips", () => {
        const original = makeLinkExpression();
        let current = original;
        for (let i = 0; i < 5; i++) {
            const record = linkToTripleRecord(current);
            current = tripleRecordToLink(record);
        }
        assert.equal(current.author, original.author);
        assert.equal(current.data.source, original.data.source);
    });
});

// ---------------------------------------------------------------------------
// blueskyPostToLink (lossy inbound)
// ---------------------------------------------------------------------------

describe("blueskyPostToLink", () => {
    it("converts a Bluesky post to a link", () => {
        const post: BskyPost = {
            $type: "app.bsky.feed.post",
            text: "Hello from Bluesky!",
            createdAt: "2026-05-02T12:00:00.000Z",
        };

        const link = blueskyPostToLink(
            post,
            "did:plc:abc123",
            "at://did:plc:abc123/app.bsky.feed.post/3k2abc",
            "neighbourhood://test",
        );

        assert.equal(link.author, "at:did:plc:abc123");
        assert.equal(link.timestamp, "2026-05-02T12:00:00.000Z");
        assert.equal(link.data.source, "neighbourhood://test");
        assert.equal(link.data.predicate, "sioc://content_of");
        assert.equal(link.data.target, "at:at://did:plc:abc123/app.bsky.feed.post/3k2abc");
    });
});

// ---------------------------------------------------------------------------
// blueskyLikeToLink
// ---------------------------------------------------------------------------

describe("blueskyLikeToLink", () => {
    it("converts a Bluesky like to a reaction link", () => {
        const like: BskyLike = {
            $type: "app.bsky.feed.like",
            subject: {
                uri: "at://did:plc:abc/app.bsky.feed.post/123",
                cid: "bafyrei123",
            },
            createdAt: "2026-05-02T12:01:00.000Z",
        };

        const link = blueskyLikeToLink(like, "did:plc:liker");
        assert.equal(link.author, "at:did:plc:liker");
        assert.equal(link.data.predicate, "flux://has_reaction");
        assert.equal(link.data.source, "at:at://did:plc:abc/app.bsky.feed.post/123");
        assert.equal(link.data.target, "emoji://👍");
    });
});

// ---------------------------------------------------------------------------
// blueskyRepostToLink
// ---------------------------------------------------------------------------

describe("blueskyRepostToLink", () => {
    it("converts a Bluesky repost to a share link", () => {
        const repost: BskyRepost = {
            $type: "app.bsky.feed.repost",
            subject: {
                uri: "at://did:plc:abc/app.bsky.feed.post/123",
                cid: "bafyrei123",
            },
            createdAt: "2026-05-02T12:02:00.000Z",
        };

        const link = blueskyRepostToLink(repost, "did:plc:reposter", "neighbourhood://test");
        assert.equal(link.author, "at:did:plc:reposter");
        assert.equal(link.data.predicate, "flux://has_share");
        assert.equal(link.data.target, "at:at://did:plc:abc/app.bsky.feed.post/123");
    });
});

// ---------------------------------------------------------------------------
// blueskyFollowToLink
// ---------------------------------------------------------------------------

describe("blueskyFollowToLink", () => {
    it("converts a Bluesky follow to a follow link", () => {
        const follow: BskyFollow = {
            $type: "app.bsky.graph.follow",
            subject: "did:plc:followed",
            createdAt: "2026-05-02T12:03:00.000Z",
        };

        const link = blueskyFollowToLink(follow, "did:plc:follower");
        assert.equal(link.author, "at:did:plc:follower");
        assert.equal(link.data.predicate, "sioc://follows");
        assert.equal(link.data.source, "at:did:plc:follower");
        assert.equal(link.data.target, "at:did:plc:followed");
    });
});

// ---------------------------------------------------------------------------
// linkToBlueskyPost
// ---------------------------------------------------------------------------

describe("linkToBlueskyPost", () => {
    it("creates a Bluesky post from a link", () => {
        const link = makeChatLink();
        const post = linkToBlueskyPost(link, {
            text: "Hello from AD4M!",
        });

        assert.equal(post.$type, "app.bsky.feed.post");
        assert.equal(post.text, "Hello from AD4M!");
        assert.equal(post.createdAt, link.timestamp);
    });

    it("includes facets when provided", () => {
        const link = makeLinkExpression();
        const post = linkToBlueskyPost(link, {
            text: "Check out #ad4m",
            facets: [{
                index: { byteStart: 10, byteEnd: 15 },
                features: [{ $type: "app.bsky.richtext.facet#tag", tag: "ad4m" }],
            }],
        });

        assert.ok(post.facets);
        assert.equal(post.facets!.length, 1);
    });
});

// ---------------------------------------------------------------------------
// linkToBlueskyLike
// ---------------------------------------------------------------------------

describe("linkToBlueskyLike", () => {
    it("creates a like record", () => {
        const link = makeLinkExpression({
            data: {
                source: "at://post/uri",
                predicate: "flux://has_reaction",
                target: "emoji://👍",
            },
        });

        const like = linkToBlueskyLike(link, "at://post/uri", "bafyrei123");
        assert.equal(like.$type, "app.bsky.feed.like");
        assert.equal(like.subject.uri, "at://post/uri");
        assert.equal(like.subject.cid, "bafyrei123");
    });
});

// ---------------------------------------------------------------------------
// linkToBlueskyRepost
// ---------------------------------------------------------------------------

describe("linkToBlueskyRepost", () => {
    it("creates a repost record", () => {
        const link = makeLinkExpression();
        const repost = linkToBlueskyRepost(link, "at://post/uri", "bafyrei123");
        assert.equal(repost.$type, "app.bsky.feed.repost");
        assert.equal(repost.subject.uri, "at://post/uri");
    });
});

// ---------------------------------------------------------------------------
// linkToRkey
// ---------------------------------------------------------------------------

describe("linkToRkey", () => {
    it("generates a TID from the link timestamp", () => {
        const link = makeLinkExpression();
        const rkey = linkToRkey(link);
        assert.equal(typeof rkey, "string");
        assert.equal(rkey.length, 13);
    });

    it("generates different TIDs for different timestamps", () => {
        const link1 = makeLinkExpression({ timestamp: "2026-05-02T00:00:00.000Z" });
        const link2 = makeLinkExpression({ timestamp: "2026-05-02T01:00:00.000Z" });
        const rkey1 = linkToRkey(link1);
        const rkey2 = linkToRkey(link2);
        assert.notEqual(rkey1, rkey2);
    });

    it("generates consistent TIDs for the same timestamp", () => {
        const link = makeLinkExpression();
        const rkey1 = linkToRkey(link);
        const rkey2 = linkToRkey(link);
        assert.equal(rkey1, rkey2);
    });
});

// ---------------------------------------------------------------------------
// diffToWriteOps
// ---------------------------------------------------------------------------

describe("diffToWriteOps", () => {
    it("converts additions to create ops", () => {
        const diff: PerspectiveDiff = {
            additions: [makeLinkExpression()],
            removals: [],
        };

        const ops = diffToWriteOps(diff, "ad4m.link.triple", simpleHash);
        assert.equal(ops.length, 1);
        assert.equal(ops[0].$type, "com.atproto.repo.applyWrites#create");
        assert.equal((ops[0] as any).collection, "ad4m.link.triple");
        assert.ok((ops[0] as any).value);
        assert.equal((ops[0] as any).value.$type, "ad4m.link.triple");
    });

    it("converts removals to delete ops", () => {
        const diff: PerspectiveDiff = {
            additions: [],
            removals: [makeLinkExpression()],
        };

        const ops = diffToWriteOps(diff, "ad4m.link.triple", simpleHash);
        assert.equal(ops.length, 1);
        assert.equal(ops[0].$type, "com.atproto.repo.applyWrites#delete");
    });

    it("handles mixed additions and removals", () => {
        const diff: PerspectiveDiff = {
            additions: [makeLinkExpression(), makeChatLink()],
            removals: [makeLinkExpression({ timestamp: "2026-01-01T00:00:00.000Z" })],
        };

        const ops = diffToWriteOps(diff, "ad4m.link.triple", simpleHash);
        assert.equal(ops.length, 3);

        const creates = ops.filter(o => o.$type === "com.atproto.repo.applyWrites#create");
        const deletes = ops.filter(o => o.$type === "com.atproto.repo.applyWrites#delete");
        assert.equal(creates.length, 2);
        assert.equal(deletes.length, 1);
    });

    it("generates unique rkeys for links with the same timestamp", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "c" },
        });

        const diff: PerspectiveDiff = {
            additions: [link1, link2],
            removals: [],
        };

        const ops = diffToWriteOps(diff, "ad4m.link.triple", simpleHash);
        const rkeys = ops.map(o => (o as any).rkey);
        assert.equal(new Set(rkeys).size, 2, "rkeys should be unique");
    });

    it("handles empty diff", () => {
        const diff: PerspectiveDiff = { additions: [], removals: [] };
        const ops = diffToWriteOps(diff, "ad4m.link.triple", simpleHash);
        assert.equal(ops.length, 0);
    });
});

// ---------------------------------------------------------------------------
// rkey is content-addressed — cross-agent collision safety
//
// Regression guard for the C1 A=18/B=18 partial-convergence freeze. Two
// co-located agents (same DID, one shared repo) each build their OWN write
// batch. A timestamp-derived TID rkey collides when two DISTINCT links share a
// millisecond: each agent's batch de-dups only against itself, so both emit the
// same TID, and the second `applyWrites#create` on the shared repo is rejected
// → that link is silently lost (the harness saw 18 of 20 land). The rkey must
// be the link's OR-Set content hash: unique per distinct link, identical for
// the same link across agents, and matching between an add and its removal.
// ---------------------------------------------------------------------------

describe("rkey content-addressing (cross-agent collision safety)", () => {
    it("distinct same-timestamp links get distinct rkeys across independent batches", () => {
        // Same millisecond, different content — the exact shape that collided.
        const ts = "2026-05-02T00:00:00.000Z";
        const a = makeLinkExpression({ timestamp: ts, data: { source: "s", predicate: "p", target: "literal://a-0" } });
        const b = makeLinkExpression({ timestamp: ts, data: { source: "s", predicate: "p", target: "literal://b-0" } });

        // Separate batches = two agents; each has its own de-dup state.
        const opsA = diffToWriteOps({ additions: [a], removals: [] }, "ad4m.link.triple", simpleHash);
        const opsB = diffToWriteOps({ additions: [b], removals: [] }, "ad4m.link.triple", simpleHash);

        assert.notEqual(
            (opsA[0] as { rkey: string }).rkey,
            (opsB[0] as { rkey: string }).rkey,
            "distinct same-timestamp links must not share an rkey on a shared repo",
        );
    });

    it("the same link yields the same rkey across independent batches (idempotent co-location)", () => {
        const link = makeLinkExpression({ timestamp: "2026-05-02T00:00:00.000Z" });
        const ops1 = diffToWriteOps({ additions: [link], removals: [] }, "ad4m.link.triple", simpleHash);
        const ops2 = diffToWriteOps({ additions: [link], removals: [] }, "ad4m.link.triple", simpleHash);
        assert.equal((ops1[0] as { rkey: string }).rkey, (ops2[0] as { rkey: string }).rkey);
    });

    it("an add and its removal target the same rkey (the delete hits the created record)", () => {
        const link = makeLinkExpression({ timestamp: "2026-05-02T00:00:00.000Z" });
        const addOps = diffToWriteOps({ additions: [link], removals: [] }, "ad4m.link.triple", simpleHash);
        const delOps = diffToWriteOps({ additions: [], removals: [link] }, "ad4m.link.triple", simpleHash);
        assert.equal(
            (addOps[0] as { rkey: string }).rkey,
            (delOps[0] as { rkey: string }).rkey,
            "removal must delete the exact record the add created",
        );
    });
});

// ---------------------------------------------------------------------------
// recordToLink (dispatch by $type)
// ---------------------------------------------------------------------------

describe("recordToLink", () => {
    it("dispatches ad4m.link.triple to tripleRecordToLink", () => {
        const record = {
            $type: "ad4m.link.triple",
            source: "s",
            predicate: "p",
            target: "t",
            author: "did:key:z6Mk1",
            timestamp: "2026-05-02T00:00:00.000Z",
        };

        const link = recordToLink(record, "did:plc:abc", "at://uri", "neighbourhood://test");
        assert.ok(link);
        assert.equal(link!.author, "did:key:z6Mk1");
        assert.equal(link!.data.source, "s");
    });

    it("dispatches app.bsky.feed.post to blueskyPostToLink", () => {
        const record = {
            $type: "app.bsky.feed.post",
            text: "Hello",
            createdAt: "2026-05-02T00:00:00.000Z",
        };

        const link = recordToLink(record, "did:plc:abc", "at://uri", "neighbourhood://test");
        assert.ok(link);
        assert.equal(link!.author, "at:did:plc:abc");
    });

    it("dispatches app.bsky.feed.like to blueskyLikeToLink", () => {
        const record = {
            $type: "app.bsky.feed.like",
            subject: { uri: "at://post", cid: "cid123" },
            createdAt: "2026-05-02T00:00:00.000Z",
        };

        const link = recordToLink(record, "did:plc:abc", "at://uri", "neighbourhood://test");
        assert.ok(link);
        assert.equal(link!.data.predicate, "flux://has_reaction");
    });

    it("dispatches app.bsky.feed.repost to blueskyRepostToLink", () => {
        const record = {
            $type: "app.bsky.feed.repost",
            subject: { uri: "at://post", cid: "cid123" },
            createdAt: "2026-05-02T00:00:00.000Z",
        };

        const link = recordToLink(record, "did:plc:abc", "at://uri", "neighbourhood://test");
        assert.ok(link);
        assert.equal(link!.data.predicate, "flux://has_share");
    });

    it("dispatches app.bsky.graph.follow to blueskyFollowToLink", () => {
        const record = {
            $type: "app.bsky.graph.follow",
            subject: "did:plc:target",
            createdAt: "2026-05-02T00:00:00.000Z",
        };

        const link = recordToLink(record, "did:plc:abc", "at://uri", "neighbourhood://test");
        assert.ok(link);
        assert.equal(link!.data.predicate, "sioc://follows");
    });

    it("returns null for unknown record types", () => {
        const record = { $type: "com.example.unknown", data: {} };
        const link = recordToLink(record, "did:plc:abc", "at://uri", "neighbourhood://test");
        assert.equal(link, null);
    });
});

// ---------------------------------------------------------------------------
// linkContentKey
// ---------------------------------------------------------------------------

describe("linkContentKey", () => {
    it("generates a deterministic content key", () => {
        const link = makeLinkExpression();
        const key1 = linkContentKey(link);
        const key2 = linkContentKey(link);
        assert.equal(key1, key2);
    });

    it("includes source, predicate, and target", () => {
        const link = makeLinkExpression();
        const key = linkContentKey(link);
        assert.ok(key.includes("literal://hello"));
        assert.ok(key.includes("sioc://content_of"));
        assert.ok(key.includes("literal://world"));
    });

    it("produces different keys for different links", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "different", target: "values", predicate: "here" },
        });
        assert.notEqual(linkContentKey(link1), linkContentKey(link2));
    });
});

// ---------------------------------------------------------------------------
// isTripleRecord / isBlueskyPost
// ---------------------------------------------------------------------------

describe("isTripleRecord", () => {
    it("returns true for ad4m.link.triple", () => {
        assert.ok(isTripleRecord({ $type: "ad4m.link.triple" }));
    });
    it("returns false for other types", () => {
        assert.ok(!isTripleRecord({ $type: "app.bsky.feed.post" }));
    });
});

describe("isBlueskyPost", () => {
    it("returns true for app.bsky.feed.post", () => {
        assert.ok(isBlueskyPost({ $type: "app.bsky.feed.post" }));
    });
    it("returns false for other types", () => {
        assert.ok(!isBlueskyPost({ $type: "ad4m.link.triple" }));
    });
});
