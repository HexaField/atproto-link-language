/**
 * Channel-B SHACL projection: literal codec, node-expression evaluator,
 * profile parsing from SHACL links, project/ingest round-trip, and the
 * ATProto adapter (app.bsky.feed.post ⇄ Projection).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    encodeLiteral,
    decodeLiteral,
    encodeTyped,
    isLiteral,
} from "../src/projection/literal.js";
import { evalExpression, isNodeExpression, type NodeExpression } from "../src/projection/expression.js";
import { parseProfiles, profileByNativeType } from "../src/projection/profile.js";
import { collectInstances, project, ingest } from "../src/projection/project.js";
import type { AuthoredLink, Link } from "../src/projection/types.js";
import { makeAtProtoAdapter, atprotoPostBase, BSKY_POST_TYPE } from "../src/atproto-projection.js";
import type { AtProtoPostRecord } from "../src/atproto-projection.js";
import type { BskyPost } from "../src/types.js";

// ---------------------------------------------------------------------------
// A realistic SHACL shape: flux://Message → app.bsky.feed.post (text field)
// ---------------------------------------------------------------------------

const SHAPE_LINKS: Link[] = [
    { source: "flux://MessageShape", predicate: "rdf://type", target: "sh://NodeShape" },
    { source: "flux://MessageShape", predicate: "sh://targetClass", target: "flux://Message" },
    { source: "flux://MessageShape", predicate: "projection://nativeType", target: "literal:string:app.bsky.feed.post" },
    { source: "flux://MessageShape", predicate: "projection://authorField", target: "literal:string:author" },
    { source: "flux://MessageShape", predicate: "projection://timestampField", target: "literal:string:createdAt" },
    { source: "flux://MessageShape", predicate: "projection://idField", target: "literal:string:uri" },
    { source: "flux://MessageShape", predicate: "sh://property", target: "flux://Message.type" },
    { source: "flux://MessageShape", predicate: "sh://property", target: "flux://Message.body" },
    // flag property (the @Flag type marker)
    { source: "flux://Message.type", predicate: "sh://path", target: "ad4m://type" },
    { source: "flux://Message.type", predicate: "sh://hasValue", target: "flux://message" },
    // content property → native `text`
    { source: "flux://Message.body", predicate: "sh://path", target: "sioc://content" },
    { source: "flux://Message.body", predicate: "sh://datatype", target: "xsd:string" },
    { source: "flux://Message.body", predicate: "projection://field", target: "literal:string:text" },
];

function messageInstance(base: string, body: string): AuthoredLink[] {
    return [
        {
            author: "did:key:alice",
            timestamp: "2026-07-12T10:00:00.000Z",
            data: { source: base, predicate: "ad4m://type", target: "flux://message" },
        },
        {
            author: "did:key:alice",
            timestamp: "2026-07-12T10:00:01.000Z",
            data: { source: base, predicate: "sioc://content", target: encodeLiteral(body) },
        },
    ];
}

// ---------------------------------------------------------------------------
// Literal codec — byte-exact with @coasys/ad4m Literal
// ---------------------------------------------------------------------------

describe("literal codec", () => {
    it("round-trips strings with RFC3986 encoding", () => {
        assert.equal(encodeLiteral("Hello world"), "literal:string:Hello%20world");
        assert.equal(decodeLiteral("literal:string:Hello%20world"), "Hello world");
    });

    it("escapes RFC3986 sub-delims !'()*", () => {
        const encoded = encodeLiteral("a!b'c(d)e*");
        assert.equal(encoded, "literal:string:a%21b%27c%28d%29e%2A");
        assert.equal(decodeLiteral(encoded), "a!b'c(d)e*");
    });

    it("round-trips numbers and booleans", () => {
        assert.equal(encodeLiteral(42), "literal:number:42");
        assert.equal(decodeLiteral("literal:number:42"), 42);
        assert.equal(encodeLiteral(true), "literal:boolean:true");
        assert.equal(decodeLiteral("literal:boolean:true"), true);
        assert.equal(decodeLiteral("literal:boolean:false"), false);
    });

    it("round-trips JSON objects", () => {
        const enc = encodeLiteral({ a: 1, b: [2, 3] });
        assert.ok(enc.startsWith("literal:json:"));
        assert.deepEqual(decodeLiteral(enc), { a: 1, b: [2, 3] });
    });

    it("tolerates the deprecated literal:// form on decode", () => {
        assert.equal(decodeLiteral("literal://string:hi%20there"), "hi there");
    });

    it("passes through non-literal URI references unchanged", () => {
        assert.equal(decodeLiteral("did:key:z6Mk"), "did:key:z6Mk");
        assert.equal(decodeLiteral("flux://message"), "flux://message");
        assert.equal(isLiteral("flux://message"), false);
        assert.equal(isLiteral("literal:string:x"), true);
    });

    it("encodeTyped coerces by xsd datatype", () => {
        assert.equal(encodeTyped("42", "xsd:integer"), "literal:number:42");
        assert.equal(encodeTyped("3.14", "http://www.w3.org/2001/XMLSchema#decimal"), "literal:number:3.14");
        assert.equal(encodeTyped("true", "xsd:boolean"), "literal:boolean:true");
        assert.equal(encodeTyped("hello", "xsd:string"), "literal:string:hello");
        assert.equal(encodeTyped("hello"), "literal:string:hello");
    });
});

// ---------------------------------------------------------------------------
// Node-expression evaluator
// ---------------------------------------------------------------------------

describe("node expression evaluator", () => {
    const lookup = (p: string) => ({ "a://x": "X", "a://y": "" } as Record<string, string>)[p];

    it("focus / literal / path", () => {
        assert.equal(evalExpression({ type: "focus" }, "F", lookup), "F");
        assert.equal(evalExpression({ type: "literal", value: "c" }, undefined, lookup), "c");
        assert.equal(evalExpression({ type: "path", predicate: "a://x" }, undefined, lookup), "X");
    });

    it("exists is true only for present non-empty values", () => {
        assert.equal(evalExpression({ type: "exists", expr: { type: "path", predicate: "a://x" } }, undefined, lookup), true);
        assert.equal(evalExpression({ type: "exists", expr: { type: "path", predicate: "a://y" } }, undefined, lookup), false);
        assert.equal(evalExpression({ type: "exists", expr: { type: "path", predicate: "a://none" } }, undefined, lookup), false);
    });

    it("if / then / else", () => {
        const expr: NodeExpression = {
            type: "if",
            cond: { type: "exists", expr: { type: "path", predicate: "a://x" } },
            then: { type: "literal", value: "YES" },
            else: { type: "literal", value: "NO" },
        };
        assert.equal(evalExpression(expr, undefined, lookup), "YES");
        const exprNo: NodeExpression = { ...expr, cond: { type: "exists", expr: { type: "path", predicate: "a://none" } } };
        assert.equal(evalExpression(exprNo, undefined, lookup), "NO");
    });

    it("concat skips nullish args; coalesce picks first present", () => {
        const cat: NodeExpression = {
            type: "concat",
            args: [
                { type: "literal", value: "data:" },
                { type: "path", predicate: "a://x" },
                { type: "path", predicate: "a://none" },
            ],
        };
        assert.equal(evalExpression(cat, undefined, lookup), "data:X");
        const co: NodeExpression = {
            type: "coalesce",
            args: [
                { type: "path", predicate: "a://none" },
                { type: "path", predicate: "a://y" },
                { type: "literal", value: "fallback" },
            ],
        };
        assert.equal(evalExpression(co, undefined, lookup), "fallback");
    });

    it("isNodeExpression guards malformed input", () => {
        assert.equal(isNodeExpression({ type: "focus" }), true);
        assert.equal(isNodeExpression({ type: "bogus" }), false);
        assert.equal(isNodeExpression("nope"), false);
    });
});

// ---------------------------------------------------------------------------
// Profile parsing
// ---------------------------------------------------------------------------

describe("parseProfiles", () => {
    it("extracts a projectable profile with fields and flags", () => {
        const profiles = parseProfiles(SHAPE_LINKS);
        assert.equal(profiles.length, 1);
        const p = profiles[0];
        assert.equal(p.nodeShapeUri, "flux://MessageShape");
        assert.equal(p.targetClass, "flux://Message");
        assert.equal(p.nativeType, "app.bsky.feed.post");
        assert.equal(p.authorField, "author");
        assert.equal(p.timestampField, "createdAt");
        assert.equal(p.idField, "uri");
        assert.equal(p.fields.length, 1);
        assert.deepEqual(p.fields[0], {
            nativeField: "text",
            path: "sioc://content",
            datatype: "xsd:string",
            expression: undefined,
        });
        assert.equal(p.flags.length, 1);
        assert.deepEqual(p.flags[0], { path: "ad4m://type", value: "flux://message" });
    });

    it("ignores shapes without projection://nativeType", () => {
        const nonProjectable: Link[] = [
            { source: "x://Shape", predicate: "rdf://type", target: "sh://NodeShape" },
            { source: "x://Shape", predicate: "sh://targetClass", target: "x://Class" },
        ];
        assert.equal(parseProfiles(nonProjectable).length, 0);
    });

    it("parses a projection://expression annotation", () => {
        const withExpr: Link[] = [
            ...SHAPE_LINKS,
            {
                source: "flux://Message.body",
                predicate: "projection://expression",
                target: encodeLiteral({ type: "focus" }),
            },
        ];
        const p = parseProfiles(withExpr)[0];
        assert.deepEqual(p.fields[0].expression, { type: "focus" });
    });

    it("indexes profiles by native type", () => {
        const map = profileByNativeType(parseProfiles(SHAPE_LINKS));
        assert.ok(map.has("app.bsky.feed.post"));
    });
});

// ---------------------------------------------------------------------------
// collectInstances + project
// ---------------------------------------------------------------------------

describe("collectInstances + project", () => {
    const profile = parseProfiles(SHAPE_LINKS)[0];

    it("collects only instances whose flags match", () => {
        const links: AuthoredLink[] = [
            ...messageInstance("flux://msg1", "Hello world"),
            // a base without the type flag — not an instance
            {
                author: "did:key:bob",
                timestamp: "2026-07-12T11:00:00.000Z",
                data: { source: "flux://other", predicate: "sioc://content", target: encodeLiteral("orphan") },
            },
        ];
        const instances = collectInstances(links, profile);
        assert.equal(instances.length, 1);
        assert.equal(instances[0].base, "flux://msg1");
        assert.equal(instances[0].author, "did:key:alice");
        assert.equal(instances[0].timestamp, "2026-07-12T10:00:00.000Z"); // earliest
    });

    it("projects an instance to generic native content without flags", () => {
        const instance = collectInstances(messageInstance("flux://msg1", "Hello world"), profile)[0];
        const projection = project(instance, profile);
        assert.equal(projection.nativeType, "app.bsky.feed.post");
        assert.equal(projection.base, "flux://msg1");
        assert.equal(projection.author, "did:key:alice");
        assert.deepEqual(projection.fields, { text: "Hello world" });
        // flag path must NOT leak into content
        assert.equal("ad4m://type" in projection.fields, false);
    });

    it("applies an outbound expression when present", () => {
        const exprLinks: Link[] = [
            ...SHAPE_LINKS,
            {
                source: "flux://Message.body",
                predicate: "projection://expression",
                target: encodeLiteral({
                    type: "concat",
                    args: [
                        { type: "literal", value: "[msg] " },
                        { type: "focus" },
                    ],
                }),
            },
        ];
        const p = parseProfiles(exprLinks)[0];
        const instance = collectInstances(messageInstance("flux://msg2", "hi"), p)[0];
        assert.equal(project(instance, p).fields.text, "[msg] hi");
    });
});

// ---------------------------------------------------------------------------
// ingest + full round-trip
// ---------------------------------------------------------------------------

describe("ingest", () => {
    const profile = parseProfiles(SHAPE_LINKS)[0];

    it("emits flag links and encoded content-field links", () => {
        const links = ingest(
            { nativeType: "app.bsky.feed.post", base: "at:at://did:plc:x/app.bsky.feed.post/3k", fields: { text: "hi from bluesky" } },
            profile,
        );
        assert.deepEqual(links, [
            { source: "at:at://did:plc:x/app.bsky.feed.post/3k", predicate: "ad4m://type", target: "flux://message" },
            { source: "at:at://did:plc:x/app.bsky.feed.post/3k", predicate: "sioc://content", target: "literal:string:hi%20from%20bluesky" },
        ]);
    });

    it("round-trips links → project → ingest reproducing content + flag links", () => {
        const instance = collectInstances(messageInstance("flux://msg1", "Hello world"), profile)[0];
        const projection = project(instance, profile);
        const rebuilt = ingest(projection, profile, instance.base);
        // original content link + flag link, order-independent
        const originalTriples = new Set([
            "flux://msg1|ad4m://type|flux://message",
            `flux://msg1|sioc://content|${encodeLiteral("Hello world")}`,
        ]);
        const rebuiltTriples = new Set(rebuilt.map((l) => `${l.source}|${l.predicate}|${l.target}`));
        assert.deepEqual(rebuiltTriples, originalTriples);
    });
});

// ---------------------------------------------------------------------------
// atprotoPostBase helper
// ---------------------------------------------------------------------------

describe("atprotoPostBase", () => {
    it("wraps a full AT-URI as an at:-prefixed reference", () => {
        assert.equal(
            atprotoPostBase("at://did:plc:x/app.bsky.feed.post/3k"),
            "at:at://did:plc:x/app.bsky.feed.post/3k",
        );
    });

    it("passes through an already at:-prefixed reference", () => {
        assert.equal(atprotoPostBase("at:at://did:plc:x/app.bsky.feed.post/3k"), "at:at://did:plc:x/app.bsky.feed.post/3k");
    });

    it("builds a canonical post AT-URI from a bare DID + rkey", () => {
        assert.equal(
            atprotoPostBase("did:plc:x", "3k"),
            "at:at://did:plc:x/app.bsky.feed.post/3k",
        );
    });
});

// ---------------------------------------------------------------------------
// ATProto adapter — the NativeAdapter
// ---------------------------------------------------------------------------

describe("atproto adapter", () => {
    const adapter = makeAtProtoAdapter();
    const profile = parseProfiles(SHAPE_LINKS)[0];

    it("toNative emits a clean app.bsky.feed.post with NO ad4m envelope", () => {
        const instance = collectInstances(messageInstance("flux://msg1", "Hello world"), profile)[0];
        const record = adapter.toNative(project(instance, profile));
        assert.equal(record.value.$type, "app.bsky.feed.post");
        assert.equal(record.value.text, "Hello world");
        assert.equal("ad4m" in record.value, false);
        // Only native post fields — content field is `text`, plus createdAt/$type.
        assert.deepEqual(Object.keys(record.value).sort(), ["$type", "createdAt", "text"]);
    });

    it("carries the projection timestamp into createdAt", () => {
        const record = adapter.toNative({
            nativeType: BSKY_POST_TYPE,
            base: "flux://m",
            timestamp: "2026-07-12T10:00:00.000Z",
            fields: { text: "hi" },
        });
        assert.equal(record.value.createdAt, "2026-07-12T10:00:00.000Z");
    });

    it("throws if the projection lacks a text field", () => {
        assert.throws(() => adapter.toNative({ nativeType: BSKY_POST_TYPE, base: "x", fields: {} }));
    });

    it("fromNative parses a located post record into a projection", () => {
        const value: BskyPost = {
            $type: "app.bsky.feed.post",
            text: "hi from bluesky",
            createdAt: "2026-07-12T12:00:00.000Z",
        };
        const record: AtProtoPostRecord = {
            value,
            uri: "at://did:plc:bob/app.bsky.feed.post/3kbob",
        };
        const p = adapter.fromNative(record);
        assert.ok(p);
        assert.equal(p!.base, atprotoPostBase("at://did:plc:bob/app.bsky.feed.post/3kbob"));
        assert.equal(p!.author, "did:plc:bob");
        assert.equal(p!.timestamp, "2026-07-12T12:00:00.000Z");
        assert.deepEqual(p!.fields, { text: "hi from bluesky" });
    });

    it("fromNative rejects non-post records", () => {
        const like: AtProtoPostRecord = {
            value: { $type: "app.bsky.feed.like", text: "x", createdAt: "" } as unknown as BskyPost,
        };
        assert.equal(adapter.fromNative(like), null);
    });

    it("fromNative yields an empty base when the record has no AT-URI to anchor on", () => {
        const anonymous: AtProtoPostRecord = {
            value: { $type: "app.bsky.feed.post", text: "x", createdAt: "" },
        };
        const p = adapter.fromNative(anonymous);
        assert.ok(p);
        assert.equal(p!.base, "");
    });

    it("full native→AD4M ingest yields a typed instance", () => {
        const record: AtProtoPostRecord = {
            value: { $type: "app.bsky.feed.post", text: "native hello", createdAt: "2026-07-12T12:00:00.000Z" },
            uri: "at://did:plc:carol/app.bsky.feed.post/3kcarol",
            authorDid: "did:plc:carol",
        };
        const projection = adapter.fromNative(record)!;
        const links = ingest(projection, profile);
        assert.deepEqual(links, [
            { source: "at:at://did:plc:carol/app.bsky.feed.post/3kcarol", predicate: "ad4m://type", target: "flux://message" },
            { source: "at:at://did:plc:carol/app.bsky.feed.post/3kcarol", predicate: "sioc://content", target: "literal:string:native%20hello" },
        ]);
    });
});
