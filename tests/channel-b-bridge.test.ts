/**
 * Channel-B bridge orchestration — the protocol-agnostic glue that every
 * plain-text link language copies verbatim: `toAuthoredLink`,
 * `projectInstances` (AD4M graph → native payloads), `ingestNative`
 * (native payload → authoritative links), and the `defaultFluxMessageProfile`
 * fallback. Exercised over the ATProto adapter (app.bsky.feed.post, `text`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    toAuthoredLink,
    projectInstances,
    ingestNative,
    defaultFluxMessageProfile,
    encodeLiteral,
    type AuthoredLink,
    type NativeAdapter,
    type ProjectionProfile,
} from "../src/projection/index.js";
import { makeAtProtoAdapter, atprotoPostBase, BSKY_POST_TYPE } from "../src/atproto-projection.js";
import type { AtProtoPostRecord } from "../src/atproto-projection.js";
import type { BskyPost } from "../src/types.js";

// The ATProto adapter, keyed by the native type a profile asks for.
const adapterFor = (nativeType: string): NativeAdapter<AtProtoPostRecord> => makeAtProtoAdapter(nativeType);

// The Flux fallback profile: `base --flux://entry_type--> flux://has_message`
// (flag) + `base --flux://body--> literal:string:<text>` (content). The content
// field here is `text` (the app.bsky.feed.post content field), NOT `body`.
const fluxProfile = defaultFluxMessageProfile(BSKY_POST_TYPE, "text");

function fluxMessage(base: string, text: string, author = "did:key:alice"): AuthoredLink[] {
    return [
        {
            author,
            timestamp: "2026-07-12T10:00:00.000Z",
            data: { source: base, predicate: "flux://entry_type", target: "flux://has_message" },
        },
        {
            author,
            timestamp: "2026-07-12T10:00:01.000Z",
            data: { source: base, predicate: "flux://body", target: encodeLiteral(text) },
        },
    ];
}

/** A located native post record (as a peer repo listing yields). */
function postRecord(uri: string, text: string, createdAt = "2026-07-12T12:00:00.000Z"): AtProtoPostRecord {
    const value: BskyPost = { $type: "app.bsky.feed.post", text, createdAt };
    return { value, uri };
}

// ---------------------------------------------------------------------------
// toAuthoredLink
// ---------------------------------------------------------------------------

describe("toAuthoredLink", () => {
    it("maps a full LinkExpression to an AuthoredLink", () => {
        const authored = toAuthoredLink({
            author: "did:key:alice",
            timestamp: "2026-07-12T10:00:00.000Z",
            data: { source: "a://s", predicate: "a://p", target: "a://t" },
        });
        assert.deepEqual(authored, {
            author: "did:key:alice",
            timestamp: "2026-07-12T10:00:00.000Z",
            data: { source: "a://s", predicate: "a://p", target: "a://t" },
        });
    });

    it("defaults missing triple parts to empty strings and preserves absent envelope", () => {
        const authored = toAuthoredLink({ data: {} });
        assert.equal(authored.author, undefined);
        assert.equal(authored.timestamp, undefined);
        assert.deepEqual(authored.data, { source: "", predicate: "", target: "" });
    });
});

// ---------------------------------------------------------------------------
// projectInstances — AD4M graph → native payloads
// ---------------------------------------------------------------------------

describe("projectInstances", () => {
    it("folds a matched instance into a native post with envelope metadata", () => {
        const projected = projectInstances<AtProtoPostRecord>(fluxMessage("flux://msg1", "Hello world"), [fluxProfile], adapterFor);
        assert.equal(projected.length, 1);
        const [p] = projected;
        assert.equal(p.base, "flux://msg1");
        assert.equal(p.author, "did:key:alice");
        assert.equal(p.timestamp, "2026-07-12T10:00:00.000Z"); // earliest constituent link
        assert.equal(p.native.value.$type, BSKY_POST_TYPE);
        assert.equal(p.native.value.text, "Hello world");
        // The projection timestamp flows into createdAt.
        assert.equal(p.native.value.createdAt, "2026-07-12T10:00:00.000Z");
        // A clean native payload — no DAG bytes leak into human content.
        assert.equal("ad4m" in p.native.value, false);
    });

    it("projects multiple distinct instances", () => {
        const additions = [...fluxMessage("flux://msg1", "one"), ...fluxMessage("flux://msg2", "two")];
        const projected = projectInstances<AtProtoPostRecord>(additions, [fluxProfile], adapterFor);
        assert.deepEqual(
            projected.map((p) => p.native.value.text).sort(),
            ["one", "two"],
        );
    });

    it("projects each base at most once across overlapping profiles (first profile wins)", () => {
        // Two profiles matching the same flag; the first should claim the base.
        const primary = defaultFluxMessageProfile(BSKY_POST_TYPE, "text");
        const shadow: ProjectionProfile = { ...defaultFluxMessageProfile("app.bsky.feed.repost", "text") };
        const projected = projectInstances<AtProtoPostRecord>(fluxMessage("flux://msg1", "hi"), [primary, shadow], adapterFor);
        assert.equal(projected.length, 1);
        assert.equal(projected[0].native.value.$type, BSKY_POST_TYPE); // first profile's native type
    });

    it("emits nothing for additions whose flags never match", () => {
        const orphan: AuthoredLink[] = [
            {
                author: "did:key:bob",
                timestamp: "2026-07-12T11:00:00.000Z",
                data: { source: "flux://other", predicate: "flux://body", target: encodeLiteral("orphan") },
            },
        ];
        assert.deepEqual(projectInstances<AtProtoPostRecord>(orphan, [fluxProfile], adapterFor), []);
    });
});

// ---------------------------------------------------------------------------
// ingestNative — native payload → authoritative links
// ---------------------------------------------------------------------------

describe("ingestNative", () => {
    const nativePost = postRecord("at://did:plc:bob/app.bsky.feed.post/3kbob", "native hello");

    it("reverses a native post into the links that constitute the instance", () => {
        const ingested = ingestNative<AtProtoPostRecord>(nativePost, [fluxProfile], adapterFor);
        assert.ok(ingested);
        const base = atprotoPostBase("at://did:plc:bob/app.bsky.feed.post/3kbob");
        assert.equal(ingested!.base, base);
        assert.equal(ingested!.author, "did:plc:bob");
        assert.equal(ingested!.timestamp, "2026-07-12T12:00:00.000Z");
        const triples = new Set(ingested!.links.map((l) => `${l.source}|${l.predicate}|${l.target}`));
        assert.deepEqual(triples, new Set([
            `${base}|flux://entry_type|flux://has_message`,
            `${base}|flux://body|${encodeLiteral("native hello")}`,
        ]));
    });

    it("returns null when no adapter recognises the payload", () => {
        const like: AtProtoPostRecord = {
            value: { $type: "app.bsky.feed.like", text: "x", createdAt: "" } as unknown as BskyPost,
        };
        assert.equal(ingestNative<AtProtoPostRecord>(like, [fluxProfile], adapterFor), null);
    });

    it("returns null when the payload carries no id to anchor a base on", () => {
        const anonymous: AtProtoPostRecord = {
            value: { $type: "app.bsky.feed.post", text: "x", createdAt: "" },
        };
        assert.equal(ingestNative<AtProtoPostRecord>(anonymous, [fluxProfile], adapterFor), null);
    });

    it("parents the ingested instance under a container when requested (default predicate)", () => {
        const ingested = ingestNative<AtProtoPostRecord>(nativePost, [fluxProfile], adapterFor, { container: "flux://channel/general" });
        assert.ok(ingested);
        const base = atprotoPostBase("at://did:plc:bob/app.bsky.feed.post/3kbob");
        const containerLink = ingested!.links.find((l) => l.predicate === "ad4m://has_child");
        assert.deepEqual(containerLink, {
            source: "flux://channel/general",
            predicate: "ad4m://has_child",
            target: base,
        });
    });

    it("honours a custom container predicate", () => {
        const ingested = ingestNative<AtProtoPostRecord>(nativePost, [fluxProfile], adapterFor, {
            container: "flux://channel/general",
            containerPredicate: "flux://has_message",
        });
        assert.ok(ingested!.links.some(
            (l) => l.predicate === "flux://has_message" && l.source === "flux://channel/general",
        ));
    });
});

// ---------------------------------------------------------------------------
// defaultFluxMessageProfile
// ---------------------------------------------------------------------------

describe("defaultFluxMessageProfile", () => {
    it("honours the app.bsky.feed.post `text` content field", () => {
        const p = defaultFluxMessageProfile(BSKY_POST_TYPE, "text");
        assert.equal(p.nodeShapeUri, "flux://MessageShape");
        assert.equal(p.targetClass, "flux://Message");
        assert.equal(p.nativeType, BSKY_POST_TYPE);
        assert.deepEqual(p.flags, [{ path: "flux://entry_type", value: "flux://has_message" }]);
        assert.equal(p.fields.length, 1);
        assert.equal(p.fields[0].nativeField, "text");
        assert.equal(p.fields[0].path, "flux://body");
        assert.equal(p.fields[0].datatype, "http://www.w3.org/2001/XMLSchema#string");
    });

    it("defaults to the `body` field when no override is given", () => {
        const p = defaultFluxMessageProfile(BSKY_POST_TYPE);
        assert.equal(p.fields[0].nativeField, "body");
    });
});
