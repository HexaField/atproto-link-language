/**
 * Link ↔ AT Proto record translation layer.
 *
 * Bridges pure translation functions with runtime adapters
 * (XRPC, storage, signing). Handles SDNA pattern detection
 * and rendering strategy.
 *
 * No ad4m:host imports — uses injected adapters.
 *
 * Also includes:
 * - Pure translation functions (was translate.pure.ts)
 * - SDNA / Subject Class pattern detection (was sdna.ts)
 * - Dual-language deduplication and origin tracking (was dual-language.ts)
 */

import type { LinkExpression, PerspectiveDiff, RepoWrite, Ad4mLinkTriple, Ad4mLinkTombstone, BskyPost, BskyLike, BskyRepost, BskyFollow, ExpressionProof } from "./types.js";
import type { ATProtoSettings } from "./settings.js";
import { generateFacets } from "./rendering.js";
import { tidFromISO } from "./xrpc.js";
import { TOMBSTONE_COLLECTION } from "./lexicon.js";

// ---------------------------------------------------------------------------
// Pure translation functions (was translate.pure.ts)
// ---------------------------------------------------------------------------

/**
 * Convert a LinkExpression to an ad4m.link.triple record.
 * This is lossless — all link data is preserved.
 */
export function linkToTripleRecord(link: LinkExpression): Ad4mLinkTriple {
    const record: Ad4mLinkTriple = {
        $type: "ad4m.link.triple",
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
        author: link.author,
        timestamp: link.timestamp,
    };

    if (link.proof && (link.proof.signature || link.proof.key)) {
        record.proof = {
            signature: link.proof.signature || "",
            key: link.proof.key || "",
        };
    }

    return record;
}

/**
 * Convert a LinkExpression to a Bluesky post record.
 */
export function linkToBlueskyPost(
    link: LinkExpression,
    opts: {
        text: string;
        facets?: BskyPost["facets"];
        embed?: BskyPost["embed"];
        reply?: BskyPost["reply"];
    },
): BskyPost {
    return {
        $type: "app.bsky.feed.post",
        text: opts.text,
        createdAt: link.timestamp || new Date().toISOString(),
        facets: opts.facets,
        embed: opts.embed,
        reply: opts.reply,
    };
}

/**
 * Create a Bluesky like record from a reaction link.
 */
export function linkToBlueskyLike(
    link: LinkExpression,
    subjectUri: string,
    subjectCid: string,
): BskyLike {
    return {
        $type: "app.bsky.feed.like",
        subject: { uri: subjectUri, cid: subjectCid },
        createdAt: link.timestamp || new Date().toISOString(),
    };
}

/**
 * Create a Bluesky repost record from a share/boost link.
 */
export function linkToBlueskyRepost(
    link: LinkExpression,
    subjectUri: string,
    subjectCid: string,
): BskyRepost {
    return {
        $type: "app.bsky.feed.repost",
        subject: { uri: subjectUri, cid: subjectCid },
        createdAt: link.timestamp || new Date().toISOString(),
    };
}

/**
 * Convert an ad4m.link.triple record back to a LinkExpression.
 */
export function tripleRecordToLink(record: Ad4mLinkTriple): LinkExpression {
    const proof: ExpressionProof = record.proof
        ? { signature: record.proof.signature || "", key: record.proof.key || "" }
        : { signature: "", key: "" };

    return {
        author: record.author,
        timestamp: record.timestamp,
        data: {
            source: record.source,
            predicate: record.predicate,
            target: record.target,
        },
        proof,
    };
}

/**
 * Convert a Bluesky post to a LinkExpression.
 */
export function blueskyPostToLink(
    record: BskyPost,
    authorDid: string,
    uri: string,
    neighbourhoodUrl: string,
): LinkExpression {
    return {
        author: `at:${authorDid}`,
        timestamp: record.createdAt,
        data: {
            source: neighbourhoodUrl,
            predicate: "sioc://content_of",
            target: `at:${uri}`,
        },
        proof: { signature: "", key: "" },
    };
}

/**
 * Convert a Bluesky like to a LinkExpression.
 */
export function blueskyLikeToLink(
    record: BskyLike,
    authorDid: string,
): LinkExpression {
    return {
        author: `at:${authorDid}`,
        timestamp: record.createdAt,
        data: {
            source: `at:${record.subject.uri}`,
            predicate: "flux://has_reaction",
            target: "emoji://👍",
        },
        proof: { signature: "", key: "" },
    };
}

/**
 * Convert a Bluesky repost to a LinkExpression.
 */
export function blueskyRepostToLink(
    record: BskyRepost,
    authorDid: string,
    neighbourhoodUrl: string,
): LinkExpression {
    return {
        author: `at:${authorDid}`,
        timestamp: record.createdAt,
        data: {
            source: neighbourhoodUrl,
            predicate: "flux://has_share",
            target: `at:${record.subject.uri}`,
        },
        proof: { signature: "", key: "" },
    };
}

/**
 * Convert a Bluesky follow to a LinkExpression.
 */
export function blueskyFollowToLink(
    record: BskyFollow,
    authorDid: string,
): LinkExpression {
    return {
        author: `at:${authorDid}`,
        timestamp: record.createdAt,
        data: {
            source: `at:${authorDid}`,
            predicate: "sioc://follows",
            target: `at:${record.subject}`,
        },
        proof: { signature: "", key: "" },
    };
}

/**
 * Generate a record key (rkey) for a link.
 */
export function linkToRkey(link: LinkExpression, clockId: number = 0): string {
    try {
        return tidFromISO(link.timestamp, clockId);
    } catch {
        return tidFromISO(new Date().toISOString(), clockId);
    }
}

/**
 * Convert a PerspectiveDiff to applyWrites operations.
 */
export function diffToWriteOps(
    diff: PerspectiveDiff,
    collection: string,
    hashFn: (data: string) => string,
): RepoWrite[] {
    const writes: RepoWrite[] = [];
    const usedRkeys = new Set<string>();

    for (const link of diff.additions) {
        let rkey = linkToRkey(link);
        while (usedRkeys.has(rkey)) {
            const hash = hashFn(JSON.stringify(link) + rkey);
            rkey = rkey.substring(0, 10) + hash.substring(0, 3);
        }
        usedRkeys.add(rkey);

        const record = linkToTripleRecord(link);
        writes.push({
            $type: "com.atproto.repo.applyWrites#create",
            collection,
            rkey,
            value: record as unknown as Record<string, unknown>,
        });
    }

    for (const link of diff.removals) {
        const rkey = linkToRkey(link);
        writes.push({
            $type: "com.atproto.repo.applyWrites#delete",
            collection,
            rkey,
        });
    }

    return writes;
}

/**
 * Translate an inbound AT Proto record to a LinkExpression.
 */
export function recordToLink(
    record: Record<string, unknown>,
    authorDid: string,
    uri: string,
    neighbourhoodUrl: string,
): LinkExpression | null {
    const type = record.$type as string;

    if (type === "ad4m.link.triple") {
        return tripleRecordToLink(record as unknown as Ad4mLinkTriple);
    }

    if (type === "app.bsky.feed.post") {
        return blueskyPostToLink(
            record as unknown as BskyPost,
            authorDid,
            uri,
            neighbourhoodUrl,
        );
    }

    if (type === "app.bsky.feed.like") {
        return blueskyLikeToLink(
            record as unknown as BskyLike,
            authorDid,
        );
    }

    if (type === "app.bsky.feed.repost") {
        return blueskyRepostToLink(
            record as unknown as BskyRepost,
            authorDid,
            neighbourhoodUrl,
        );
    }

    if (type === "app.bsky.graph.follow") {
        return blueskyFollowToLink(
            record as unknown as BskyFollow,
            authorDid,
        );
    }

    return null;
}

/**
 * Compute a content key for deduplication.
 */
export function linkContentKey(link: LinkExpression): string {
    return `${link.data.source || ""}:${link.data.predicate || ""}:${link.data.target || ""}`;
}

/**
 * Check if a record is an ad4m.link.triple.
 */
export function isTripleRecord(record: Record<string, unknown>): boolean {
    return record.$type === "ad4m.link.triple";
}

/**
 * Check if a record is a Bluesky post.
 */
export function isBlueskyPost(record: Record<string, unknown>): boolean {
    return record.$type === "app.bsky.feed.post";
}

// ---------------------------------------------------------------------------
// SDNA / Subject Class pattern detection (was sdna.ts)
// ---------------------------------------------------------------------------

export interface DetectedPattern {
    type: "chat-message" | "reply" | "content" | "mention" | "reaction" | "share" | "follow" | "unknown";
    contentUri?: string;
    parentUri?: string;
    channelUri?: string;
    mentionedAgent?: string;
    sharedUri?: string;
    followedAgent?: string;
}

const REPLY_PREDICATES = new Set([
    "flux://has_reply",
    "sioc://reply_of",
]);

const REACTION_PREDICATES = new Set([
    "flux://has_reaction",
    "emoji://reaction",
]);

const SHARE_PREDICATES = new Set([
    "flux://has_share",
    "sioc://shares",
]);

const FOLLOW_PREDICATES = new Set([
    "sioc://follows",
    "flux://follows",
]);

const CONTENT_PREDICATE = "sioc://content_of";

export function detectPattern(
    link: LinkExpression,
    chatPredicates: string[],
): DetectedPattern {
    const predicate = link.data.predicate || "";
    const source = link.data.source || "";
    const target = link.data.target || "";

    if (predicate && chatPredicates.includes(predicate)) {
        return { type: "chat-message", contentUri: target, channelUri: source };
    }
    if (REPLY_PREDICATES.has(predicate)) {
        return { type: "reply", contentUri: target, parentUri: source };
    }
    if (predicate && predicate.toLowerCase().includes("mention")) {
        return { type: "mention", mentionedAgent: target };
    }
    if (REACTION_PREDICATES.has(predicate)) {
        return { type: "reaction", contentUri: target };
    }
    if (SHARE_PREDICATES.has(predicate)) {
        return { type: "share", sharedUri: target };
    }
    if (FOLLOW_PREDICATES.has(predicate)) {
        return { type: "follow", followedAgent: target };
    }
    if (predicate === CONTENT_PREDICATE) {
        return { type: "content", contentUri: target };
    }
    return { type: "unknown" };
}

export function isChatMessage(link: LinkExpression, chatPredicates: string[]): boolean {
    return detectPattern(link, chatPredicates).type === "chat-message";
}

export function isReply(link: LinkExpression): boolean {
    return REPLY_PREDICATES.has(link.data.predicate || "");
}

export function isReaction(link: LinkExpression): boolean {
    return REACTION_PREDICATES.has(link.data.predicate || "");
}

export function isShare(link: LinkExpression): boolean {
    return SHARE_PREDICATES.has(link.data.predicate || "");
}

export function isFollow(link: LinkExpression): boolean {
    return FOLLOW_PREDICATES.has(link.data.predicate || "");
}

export function patternToBlueskyType(pattern: DetectedPattern): string | null {
    switch (pattern.type) {
        case "chat-message":
        case "content":
        case "reply":
            return "app.bsky.feed.post";
        case "reaction":
            return "app.bsky.feed.like";
        case "share":
            return "app.bsky.feed.repost";
        case "follow":
            return "app.bsky.graph.follow";
        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// Dual-language deduplication and origin tracking (was dual-language.ts)
// ---------------------------------------------------------------------------

export type LinkOrigin = "atproto" | "native" | "dual";

function canonicalLinkData(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

export function isDuplicate(
    link: LinkExpression,
    existingHashes: Set<string>,
    hashFn: (data: string) => string,
): boolean {
    const contentHash = hashFn(canonicalLinkData(link));
    return existingHashes.has(contentHash);
}

export function linkContentHash(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    return hashFn(canonicalLinkData(link));
}

export function linkOriginKey(linkHash: string): string {
    return `link-origin/${linkHash}`;
}

// ---------------------------------------------------------------------------
// Canonical link identity (OR-Set element key)
// ---------------------------------------------------------------------------

/**
 * Canonical serialization of a link's FULL identity — triple + author +
 * timestamp. This is the OR-Set element: two adds of the same triple by
 * different authors (or at different times) are *distinct* elements, and a
 * tombstone matches the exact observed link. (This is stronger than
 * {@link linkContentKey}, which covers only source/predicate/target and is
 * used for the dual-language echo filter.)
 */
export function canonicalLinkIdentity(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source ?? null,
        predicate: link.data.predicate ?? null,
        target: link.data.target ?? null,
        author: link.author,
        timestamp: link.timestamp,
    });
}

/**
 * The OR-Set element key for a link: a content hash over its full identity.
 * Both an addition (the `ad4m.link.triple` record) and a removal (the
 * `ad4m.link.tombstone` record's `linkHash`) key on this exact value, so a
 * removal in one repo converges against the add in another.
 */
export function linkHash(link: LinkExpression, hashFn: (data: string) => string): string {
    return hashFn(canonicalLinkIdentity(link));
}

// ---------------------------------------------------------------------------
// Tombstones (first-class removals carrying the original link hash)
// ---------------------------------------------------------------------------

/**
 * Build a tombstone record for a removed link. The `linkHash` is the
 * original link's OR-Set element key (see {@link linkHash}); the echoed
 * triple is informational only.
 */
export function linkToTombstoneRecord(
    link: LinkExpression,
    hashFn: (data: string) => string,
): Ad4mLinkTombstone {
    return {
        $type: "ad4m.link.tombstone",
        linkHash: linkHash(link, hashFn),
        source: link.data.source || undefined,
        predicate: link.data.predicate || undefined,
        target: link.data.target || undefined,
        author: link.author,
        timestamp: link.timestamp,
    };
}

/** True if a record is an ad4m.link.tombstone. */
export function isTombstoneRecord(record: Record<string, unknown>): boolean {
    return record.$type === "ad4m.link.tombstone";
}

/** Extract the original link hash a tombstone record removes. */
export function tombstoneLinkHash(record: Record<string, unknown>): string | null {
    if (!isTombstoneRecord(record)) return null;
    const h = record.linkHash;
    return typeof h === "string" && h.length > 0 ? h : null;
}

export function shouldFederate(
    linkHash: string,
    getOrigin: (key: string) => string | null,
): boolean {
    const origin = getOrigin(linkOriginKey(linkHash));
    if (origin === null) return true;
    return origin !== "atproto";
}

export function isPredicateExcluded(
    predicate: string,
    excludePredicates: string[],
): boolean {
    if (excludePredicates.length === 0) return false;
    return excludePredicates.includes(predicate);
}

export function shouldFederateLink(
    link: LinkExpression,
    linkHash: string,
    getOrigin: (key: string) => string | null,
    excludePredicates: string[],
): boolean {
    const predicate = link.data.predicate || "";
    if (isPredicateExcluded(predicate, excludePredicates)) return false;
    return shouldFederate(linkHash, getOrigin);
}

// ---------------------------------------------------------------------------
// Outbound translation
// ---------------------------------------------------------------------------

export interface CommitOptions {
    did: string;
    collection: string;
    settings: ATProtoSettings;
    neighbourhoodUrl: string;
    hashFn: (data: string) => string;
    shouldFederate: (linkHash: string) => boolean;
}

/**
 * Translate a PerspectiveDiff into write operations for the PDS.
 *
 * Applies rendering strategy:
 * - "native" → only ad4m.link.triple records
 * - "bluesky" → only app.bsky.* records (for supported patterns)
 * - "dual" → both native triples and Bluesky records
 *
 * Applies federation filter (skip links from AT Proto origin).
 */
export function translateDiffToWrites(
    diff: PerspectiveDiff,
    opts: CommitOptions,
): RepoWrite[] {
    const writes: RepoWrite[] = [];
    const usedRkeys = new Set<string>();
    const { settings, hashFn, shouldFederate, collection } = opts;
    const strategy = settings.rendering.strategy;

    for (const link of diff.additions) {
        const linkHash = hashFn(linkContentKey(link));

        // Check federation filter
        if (!shouldFederate(linkHash)) continue;

        let rkey = linkToRkey(link);
        while (usedRkeys.has(rkey)) {
            const h = hashFn(JSON.stringify(link) + rkey);
            rkey = rkey.substring(0, 10) + h.substring(0, 3);
        }
        usedRkeys.add(rkey);

        // Native triple
        if (strategy === "native" || strategy === "dual") {
            const record = linkToTripleRecord(link);
            writes.push({
                $type: "com.atproto.repo.applyWrites#create",
                collection,
                rkey,
                value: record as unknown as Record<string, unknown>,
            });
        }

        // Bluesky record (for supported patterns)
        if (strategy === "bluesky" || strategy === "dual") {
            const pattern = detectPattern(link, settings.rendering.chatPredicates);

            if (pattern.type === "chat-message" || pattern.type === "content") {
                // Generate a Bluesky post
                const text = extractTextContent(link);
                if (text) {
                    const facets = generateFacets(text);
                    const bskyRkey = `bsky-${rkey}`;
                    usedRkeys.add(bskyRkey);

                    const post = linkToBlueskyPost(link, { text, facets });
                    writes.push({
                        $type: "com.atproto.repo.applyWrites#create",
                        collection: "app.bsky.feed.post",
                        rkey: bskyRkey,
                        value: post as unknown as Record<string, unknown>,
                    });
                }
            }
        }
    }

    for (const link of diff.removals) {
        const originHash = hashFn(linkContentKey(link));
        if (!shouldFederate(originHash)) continue;

        const rkey = linkToRkey(link);

        if (strategy === "native" || strategy === "dual") {
            // First-class removal: write an ad4m.link.tombstone record carrying
            // the ORIGINAL link hash so a delete here converges against the add
            // in another repo under the cross-repo OR-Set. The tombstone shares
            // the removed link's OR-Set hash as its rkey so it co-locates with
            // (and is idempotent against) the add it removes.
            const tombstone = linkToTombstoneRecord(link, hashFn);
            writes.push({
                $type: "com.atproto.repo.applyWrites#create",
                collection: TOMBSTONE_COLLECTION,
                rkey: tombstone.linkHash,
                value: tombstone as unknown as Record<string, unknown>,
            });

            // Also delete the local triple record so the repo listing no longer
            // carries the add (the OR-Set element is the tombstone from here on).
            writes.push({
                $type: "com.atproto.repo.applyWrites#delete",
                collection,
                rkey,
            });
        }

        if (strategy === "bluesky" || strategy === "dual") {
            writes.push({
                $type: "com.atproto.repo.applyWrites#delete",
                collection: "app.bsky.feed.post",
                rkey: `bsky-${rkey}`,
            });
        }
    }

    return writes;
}

/**
 * Extract text content from a link's target URI.
 *
 * Handles literal:// URIs directly. For expression URIs (expr://),
 * returns a placeholder — in production this would resolve via
 * the expression store.
 */
function extractTextContent(link: LinkExpression): string | null {
    const target = link.data.target || "";

    // literal:// URIs contain the content directly
    if (target.startsWith("literal://")) {
        try {
            const decoded = decodeURIComponent(target.replace("literal://", ""));
            // Try to parse as JSON string
            try {
                const parsed = JSON.parse(decoded);
                if (typeof parsed === "string") return parsed;
                if (typeof parsed === "object" && parsed !== null) {
                    // Look for common content fields
                    return parsed.content || parsed.text || parsed.message || JSON.stringify(parsed);
                }
                return String(parsed);
            } catch {
                return decoded;
            }
        } catch {
            return target.replace("literal://", "");
        }
    }

    // For expr:// URIs, we can't resolve in pure translation
    // Return null — the caller should resolve the expression
    if (target.startsWith("expr://")) {
        return null;
    }

    // For other URIs, use the URI itself as text
    if (target.startsWith("http://") || target.startsWith("https://")) {
        return target;
    }

    return null;
}

/**
 * Translate inbound records to links.
 */
export function translateRecordsToLinks(
    records: Array<{ uri: string; cid: string; value: Record<string, unknown> }>,
    neighbourhoodUrl: string,
): LinkExpression[] {
    const links: LinkExpression[] = [];

    for (const record of records) {
        // Extract DID from AT URI: at://did:plc:abc/collection/rkey
        const uriParts = record.uri.replace("at://", "").split("/");
        const authorDid = uriParts[0] || "";

        const link = recordToLink(
            record.value,
            authorDid,
            record.uri,
            neighbourhoodUrl,
        );

        if (link) {
            links.push(link);
        }
    }

    return links;
}

