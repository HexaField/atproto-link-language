/**
 * Custom Lexicon definitions for AD4M on AT Protocol.
 *
 * Defines the `ad4m.link.triple` and `ad4m.link.neighbourhood` Lexicon
 * schemas as specified in the proposal §6.
 *
 * These are static definitions — no runtime dependencies.
 */

/**
 * ad4m.link.triple Lexicon schema.
 * An AD4M link — a signed semantic triple with author and timestamp.
 */
export const AD4M_LINK_TRIPLE_LEXICON = {
    lexicon: 1,
    id: "ad4m.link.triple",
    revision: 1,
    description: "An AD4M link — a signed semantic triple with author and timestamp.",
    defs: {
        main: {
            type: "record",
            key: "tid",
            record: {
                type: "object",
                required: ["source", "predicate", "target", "author", "timestamp"],
                properties: {
                    source: {
                        type: "string",
                        maxLength: 4096,
                        description: "Source URI of the link triple",
                    },
                    predicate: {
                        type: "string",
                        maxLength: 1024,
                        description: "Predicate URI of the link triple",
                    },
                    target: {
                        type: "string",
                        maxLength: 4096,
                        description: "Target URI of the link triple",
                    },
                    author: {
                        type: "string",
                        maxLength: 512,
                        description: "DID of the link author",
                    },
                    timestamp: {
                        type: "string",
                        format: "datetime",
                        description: "ISO-8601 timestamp of link creation",
                    },
                    proof: {
                        type: "ref",
                        ref: "#proof",
                    },
                },
            },
        },
        proof: {
            type: "object",
            description: "AD4M LinkExpression proof (signature + key)",
            properties: {
                signature: { type: "string", maxLength: 512 },
                key: { type: "string", maxLength: 512 },
            },
        },
    },
} as const;

/**
 * ad4m.link.tombstone Lexicon schema.
 *
 * A first-class removal record. It carries the ORIGINAL link's content hash
 * (`linkHash`) so that a deletion in one repo converges against the addition
 * of that exact link in another repo, under the cross-repo OR-Set. The
 * removed triple is echoed for human/native readers but the `linkHash` is
 * what the OR-Set matches on.
 */
export const AD4M_LINK_TOMBSTONE_LEXICON = {
    lexicon: 1,
    id: "ad4m.link.tombstone",
    revision: 1,
    description: "A first-class AD4M link removal carrying the original link's content hash.",
    defs: {
        main: {
            type: "record",
            key: "tid",
            record: {
                type: "object",
                required: ["linkHash", "author", "timestamp"],
                properties: {
                    linkHash: {
                        type: "string",
                        maxLength: 256,
                        description: "Content hash of the removed link (the OR-Set element key)",
                    },
                    source: {
                        type: "string",
                        maxLength: 4096,
                        description: "Source URI of the removed link (echo, informational)",
                    },
                    predicate: {
                        type: "string",
                        maxLength: 1024,
                        description: "Predicate URI of the removed link (echo, informational)",
                    },
                    target: {
                        type: "string",
                        maxLength: 4096,
                        description: "Target URI of the removed link (echo, informational)",
                    },
                    author: {
                        type: "string",
                        maxLength: 512,
                        description: "DID of the agent performing the removal",
                    },
                    timestamp: {
                        type: "string",
                        format: "datetime",
                        description: "ISO-8601 timestamp of the removal",
                    },
                },
            },
        },
    },
} as const;

/**
 * ad4m.link.neighbourhood Lexicon schema.
 * Metadata record for an AD4M Neighbourhood on AT Protocol.
 */
export const AD4M_LINK_NEIGHBOURHOOD_LEXICON = {
    lexicon: 1,
    id: "ad4m.link.neighbourhood",
    defs: {
        main: {
            type: "record",
            key: "literal:self",
            record: {
                type: "object",
                required: ["name", "description"],
                properties: {
                    name: { type: "string", maxLength: 256 },
                    description: { type: "string", maxLength: 2048 },
                    neighbourhoodUrl: { type: "string", maxLength: 1024 },
                    linkLanguageHash: { type: "string", maxLength: 256 },
                    sdnaPatterns: {
                        type: "array",
                        items: { type: "string" },
                        description: "SDNA predicate patterns this neighbourhood uses",
                    },
                },
            },
        },
    },
} as const;

/** Collection NSID for native triples */
export const TRIPLE_COLLECTION = "ad4m.link.triple";

/** Collection NSID for first-class removals (tombstones) */
export const TOMBSTONE_COLLECTION = "ad4m.link.tombstone";

/** Collection NSID for neighbourhood metadata */
export const NEIGHBOURHOOD_COLLECTION = "ad4m.link.neighbourhood";

/**
 * Validate a record against the ad4m.link.tombstone schema.
 * Returns true if the record has all required fields with correct types.
 */
export function validateTombstoneRecord(record: Record<string, unknown>): boolean {
    if (typeof record.linkHash !== "string") return false;
    if (typeof record.author !== "string") return false;
    if (typeof record.timestamp !== "string") return false;
    if (record.linkHash.length === 0 || record.linkHash.length > 256) return false;
    if (record.author.length > 512) return false;
    if (record.source !== undefined && typeof record.source !== "string") return false;
    if (record.predicate !== undefined && typeof record.predicate !== "string") return false;
    if (record.target !== undefined && typeof record.target !== "string") return false;
    return true;
}

/**
 * Validate a record against the ad4m.link.triple schema.
 * Returns true if the record has all required fields with correct types.
 */
export function validateTripleRecord(record: Record<string, unknown>): boolean {
    if (typeof record.source !== "string") return false;
    if (typeof record.predicate !== "string") return false;
    if (typeof record.target !== "string") return false;
    if (typeof record.author !== "string") return false;
    if (typeof record.timestamp !== "string") return false;
    if (record.source.length > 4096) return false;
    if (record.predicate.length > 1024) return false;
    if (record.target.length > 4096) return false;
    if (record.author.length > 512) return false;
    // Validate proof if present
    if (record.proof !== undefined && record.proof !== null) {
        const proof = record.proof as Record<string, unknown>;
        if (typeof proof !== "object") return false;
        if (proof.signature !== undefined && typeof proof.signature !== "string") return false;
        if (proof.key !== undefined && typeof proof.key !== "string") return false;
    }
    return true;
}

/**
 * Validate a record against the ad4m.link.neighbourhood schema.
 */
export function validateNeighbourhoodRecord(record: Record<string, unknown>): boolean {
    if (typeof record.name !== "string") return false;
    if (typeof record.description !== "string") return false;
    if (record.name.length > 256) return false;
    if (record.description.length > 2048) return false;
    if (record.neighbourhoodUrl !== undefined && typeof record.neighbourhoodUrl !== "string") return false;
    if (record.linkLanguageHash !== undefined && typeof record.linkLanguageHash !== "string") return false;
    if (record.sdnaPatterns !== undefined && !Array.isArray(record.sdnaPatterns)) return false;
    return true;
}
