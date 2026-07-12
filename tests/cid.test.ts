/**
 * Unit tests for the content-addressing stack (DAG-CBOR + sha-256 + CIDv1).
 *
 * The strongest anchor is a **known-answer test**: the CID of the empty
 * DAG-CBOR map `{}` is a spec constant across the IPLD/ATProto ecosystem
 * (`bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua`). Matching it
 * proves this pure implementation reproduces real CIDv1(dag-cbor, sha-256)
 * hashes — not merely an internally-consistent hash.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    base32Encode,
    base32Decode,
    utf8Encode,
    sha256,
    encodeDagCbor,
    cidForValue,
    cidV1DagCbor,
    isCommitCid,
    CidLink,
    CODEC_DAG_CBOR,
} from "../src/cid.js";

function toHex(bytes: Uint8Array): string {
    return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

describe("sha-256 (known-answer)", () => {
    it("hashes the empty input to the FIPS 180-4 vector", () => {
        assert.equal(
            toHex(sha256(new Uint8Array(0))),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
    });

    it('hashes "abc" to the FIPS 180-4 vector', () => {
        assert.equal(
            toHex(sha256(utf8Encode("abc"))),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    });
});

describe("base32 round-trip", () => {
    it("encodes then decodes back to the same bytes", () => {
        const bytes = new Uint8Array([0, 1, 2, 250, 128, 42, 17, 255]);
        assert.deepEqual([...base32Decode(base32Encode(bytes))], [...bytes]);
    });
});

describe("DAG-CBOR encoding", () => {
    it("encodes the empty map as 0xa0", () => {
        assert.deepEqual([...encodeDagCbor({})], [0xa0]);
    });

    it("orders map keys canonically (length-first, then bytewise)", () => {
        // "b" (len 1) sorts before "aa" (len 2) under DAG-CBOR ordering, even
        // though "aa" < "b" lexically — the encoding must reflect that.
        const enc = encodeDagCbor({ aa: 1, b: 2 });
        // map(2) then first key must be the 1-byte string "b" (0x61 0x62).
        assert.equal(enc[0], 0xa2);
        assert.equal(enc[1], 0x61); // text(1)
        assert.equal(enc[2], "b".charCodeAt(0));
    });

    it("drops undefined-valued keys", () => {
        assert.deepEqual([...encodeDagCbor({ a: undefined })], [...encodeDagCbor({})]);
    });

    it("encodes negative integers via major type 1", () => {
        assert.deepEqual([...encodeDagCbor(-1)], [0x20]);
    });

    it("rejects non-integer numbers", () => {
        assert.throws(() => encodeDagCbor(1.5), /integer/);
    });
});

describe("CIDv1 (dag-cbor + sha-256)", () => {
    it("produces the canonical CID for the empty map (known-answer)", () => {
        assert.equal(
            cidForValue({}),
            "bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua",
        );
    });

    it("is deterministic and key-order-independent for equal maps", () => {
        const a = cidForValue({ x: 1, y: "two", z: [1, 2, 3] });
        const b = cidForValue({ z: [1, 2, 3], y: "two", x: 1 });
        assert.equal(a, b);
    });

    it("different content yields a different CID", () => {
        assert.notEqual(cidForValue({ a: 1 }), cidForValue({ a: 2 }));
    });

    it("isCommitCid accepts produced CIDs and rejects non-CIDs", () => {
        assert.ok(isCommitCid(cidForValue({ hello: "world" })));
        assert.equal(isCommitCid("not-a-cid"), false);
        assert.equal(isCommitCid("Qmv0base58looking"), false); // CIDv0 framing
        assert.equal(isCommitCid(""), false);
    });

    it("encodes a CID link (tag 42) and CIDs a structure containing it", () => {
        const inner = cidForValue({ leaf: true });
        const enc = encodeDagCbor({ v: new CidLink(inner) });
        // Contains the CBOR tag 42 head (0xd8 0x2a) somewhere in the output.
        const hex = toHex(enc);
        assert.ok(hex.includes("d82a"), "CID link must encode as tag 42");
        // And the wrapping structure is itself CID-able and stable.
        assert.equal(cidForValue({ v: new CidLink(inner) }), cidForValue({ v: new CidLink(inner) }));
    });

    it("cidV1DagCbor uses the dag-cbor codec byte", () => {
        const cid = cidV1DagCbor(encodeDagCbor({ a: 1 }));
        const bytes = base32Decode(cid.slice(1));
        assert.equal(bytes[1], CODEC_DAG_CBOR);
    });
});
