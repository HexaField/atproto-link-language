/**
 * # AT Protocol Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via Bluesky's AT Protocol using a
 * two-channel architecture (see SPEC_LINK_LANGUAGE_DIFFDAG_CONVERGENCE.md).
 *
 * **Channel A — convergence substrate (source of truth).** Each AD4M link diff
 * rides this repo's signed MST commit chain: additions become
 * `ad4m.link.triple` records, removals become `ad4m.link.tombstone` records
 * carrying the original link's OR-Set hash. Cross-repo convergence is the
 * OR-Set union folded from every participating repo (add-wins, remove-wins on
 * the observed hash); `currentRevision()` is the version-vector digest of the
 * per-repo commit-CID heads. The materialised link set is a derived cache,
 * never the source of truth (`store.foldLinks`).
 *
 * **Channel B — native projection (derived, SHACL-driven).** Flux chat messages
 * (and any projectable subject class) are ALSO rendered as human-readable
 * `app.bsky.feed.post` records so native Bluesky clients display them. Which
 * graph property fills the post `text` is decided by a SHACL projection profile
 * (parsed from any `projection://`-annotated shapes in the perspective, falling
 * back to the built-in Flux message profile). This projection is derived by
 * folding Channel A; it is lossy and is NEVER read back to rebuild the DAG. No
 * AD4M data is smuggled into `text`. The one inbound path: genuinely
 * native-authored posts — from a repo/DID that posts ONLY via Bluesky with no
 * AD4M identity mapping — are INGESTED as new authoritative links that then
 * enter Channel A.
 *
 * Implements perspective-commit, perspective-sync, perspective-query, and peers
 * capabilities.
 *
 * Spec: atproto-link-language.md
 */

import {
    defineLanguage,
    agentDid,
    hash,
    languageSettings,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";

import type { PerspectiveDiff, LinkExpression } from "./src/types.js";
import { parseSettings } from "./src/settings.js";
import type { ATProtoSettings } from "./src/settings.js";
import { translateDiffToWrites, shouldFederate, linkOriginKey } from "./src/translate.js";
import * as store from "./src/store.js";
import * as xrpc from "./src/xrpc.js";
import { tidNow } from "./src/xrpc.js";
import { authenticate, getAccessToken } from "./src/auth.js";
import { foldAndEmit } from "./src/sync.js";
import { TRIPLE_COLLECTION } from "./src/lexicon.js";

// Channel-B (Role B) projection — SHACL-driven native ⇄ graph transform.
import { makeAtProtoAdapter, BSKY_POST_TYPE, atprotoPostBase } from "./src/atproto-projection.js";
import type { AtProtoPostRecord } from "./src/atproto-projection.js";
import {
    parseProfiles,
    projectInstances,
    ingestNative,
    toAuthoredLink,
    defaultFluxMessageProfile,
    type ProjectionProfile,
} from "./src/projection/index.js";

// Adapter imports
import { initTransport, initStorage, getStorage, initSigning, initRuntime } from "./src/adapters.js";
import { DenoTransport, DenoStorageAdapter, DenoSigningAdapter, DenoRuntime } from "./src/adapters-deno.js";

// ---------------------------------------------------------------------------
// Template Variables (per Spec §9)
// ---------------------------------------------------------------------------

//!@ad4m-template-variable
const AT_PDS_URL = "<to-be-filled>";

//!@ad4m-template-variable
const AT_RELAY_URL = "<to-be-filled>";

//!@ad4m-template-variable
const AT_DID = "<to-be-filled>";

//!@ad4m-template-variable
const AT_HANDLE = "<to-be-filled>";

//!@ad4m-template-variable
const AT_COLLECTION_NSID = "<to-be-filled>";

//!@ad4m-template-variable
const AT_APP_PASSWORD = "<to-be-filled>";

//!@ad4m-template-variable
const NEIGHBOURHOOD_META = "<to-be-filled>";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let settings: ATProtoSettings;

/**
 * Get the neighbourhood URL from the language address.
 */
function neighbourhoodUrl(): string {
    return `neighbourhood://${AT_DID}`;
}

/**
 * Get the collection NSID, defaulting to ad4m.link.triple.
 */
function collectionNsid(): string {
    return AT_COLLECTION_NSID !== "<to-be-filled>" ? AT_COLLECTION_NSID : TRIPLE_COLLECTION;
}

// ---------------------------------------------------------------------------
// Channel-B (Role B) projection wiring
//
// The ATProto adapter maps a generic Projection ⇄ a real app.bsky.feed.post.
// Which graph property fills the post `text` is decided by the SHACL projection
// profile — parsed from any projection://-annotated shapes in the perspective,
// falling back to the built-in Flux message profile (targeting the post `text`
// field) so stock Flux projects without SDNA annotations. No AD4M data is ever
// smuggled into the post text; the projection is derived from Channel A and
// never read back as truth (native-authored posts are ingested through
// `ingestNativePosts` only).
// ---------------------------------------------------------------------------

/** The single ATProto Channel-B adapter (app.bsky.feed.post ⇄ Projection). */
type NativeAdapterForPost = ReturnType<typeof makeAtProtoAdapter>;
const atprotoAdapter: NativeAdapterForPost = makeAtProtoAdapter();
const adapterFor = (): NativeAdapterForPost => atprotoAdapter;

/** Cached projection profiles; invalidated whenever SHACL shape links change. */
let cachedProfiles: ProjectionProfile[] | null = null;

/**
 * Projection profiles for this perspective. Parses `projection://`-annotated
 * SHACL shapes from the folded link set, and guarantees a profile targeting
 * `app.bsky.feed.post` (content field `text`) so Flux always projects even
 * without explicit SDNA annotations.
 */
function projectionProfiles(): ProjectionProfile[] {
    if (cachedProfiles) return cachedProfiles;
    const shapeLinks = store.allLinks().links.map((l) => ({
        source: l.data.source ?? "",
        predicate: l.data.predicate ?? "",
        target: l.data.target ?? "",
    }));
    const parsed = parseProfiles(shapeLinks);
    cachedProfiles = parsed.some((p) => p.nativeType === BSKY_POST_TYPE)
        ? parsed
        : [...parsed, defaultFluxMessageProfile(BSKY_POST_TYPE, "text")];
    return cachedProfiles;
}

/** True if a diff adds/removes any SHACL shape or projection annotation link. */
function diffTouchesShapes(diff: PerspectiveDiff): boolean {
    const isShapePred = (p?: string) =>
        !!p && (p.startsWith("sh://") || p.startsWith("projection://") || p === "rdf://type");
    return diff.additions.some((l) => isShapePred(l.data.predicate)) ||
        diff.removals.some((l) => isShapePred(l.data.predicate));
}

function invalidateProfilesIfShapes(diff: PerspectiveDiff): void {
    if (diffTouchesShapes(diff)) cachedProfiles = null;
}

// ---------------------------------------------------------------------------
// Echo suppression + AD4M-identity mapping (Channel-B inbound)
//
// A repo DID is a "known AD4M identity" iff it converges on Channel A — i.e. it
// is our own repo, or a peer repo whose `ad4m.link.triple`/`ad4m.link.tombstone`
// records we fold (so it appears in `store.peerRepoDids()`). Such a repo's
// `app.bsky.feed.post` records are our own or another bridge's Channel-B output
// and must NOT be re-ingested — their links already arrived authoritatively via
// Channel A. Only a repo that posts ONLY via Bluesky (no AD4M records, so no
// Channel-A footprint) is a genuine native author whose posts we ingest.
// Idempotency: each ingested post AT-URI is recorded so re-seeing it never
// double-ingests.
// ---------------------------------------------------------------------------

const INGESTED_POST_PREFIX = "channelb/ingested/";

/** True if a repo DID converges on Channel A (own repo or a folded peer). */
function isAd4mRepo(did: string): boolean {
    if (!did) return false;
    if (did === store.getLocalDid()) return true;
    return store.peerRepoDids().includes(did);
}

/** True if a post AT-URI was already ingested (idempotency). */
function isPostIngested(uri: string): boolean {
    return getStorage().get(`${INGESTED_POST_PREFIX}${uri}`) !== null;
}

/** Record that a post AT-URI has been ingested. */
function markPostIngested(uri: string): void {
    getStorage().put(`${INGESTED_POST_PREFIX}${uri}`, "1");
}

// ---------------------------------------------------------------------------
// Channel-A outbound (substrate) — always publishes the authoritative triples
//
// Channel A rides the MST commit chain of `ad4m.link.triple` (adds) +
// `ad4m.link.tombstone` (removals) records regardless of the rendering
// strategy: the substrate is the source of truth, the rendering strategy
// governs Channel B (native projection) ONLY. We therefore derive the
// Channel-A writes with a native-forced strategy so no `app.bsky.feed.post`
// records leak in here — Channel B owns every post.
// ---------------------------------------------------------------------------

function channelASettings(): ATProtoSettings {
    return { ...settings, rendering: { ...settings.rendering, strategy: "native" } };
}

/**
 * Publish a diff on Channel A: advance the local MST commit chain and submit
 * the substrate writes (triples + tombstones) to the PDS. Returns the new local
 * commit CID (the head). Does NOT emit the perspective diff — the caller owns
 * emission (so commit and ingest can sequence emission with their own logic).
 */
async function publishDiffRoleA(diff: PerspectiveDiff): Promise<string> {
    const newHead = store.applyLocalDiff(diff);

    // Track link origins so the dual-language echo filter suppresses re-federation.
    for (const link of diff.additions) {
        const h = store.hashLink(link);
        const originKey = linkOriginKey(h);
        const storage = getStorage();
        const existing = storage.get(originKey);
        if (existing === "atproto") storage.put(originKey, "dual");
        else if (!existing) storage.put(originKey, "native");
    }

    if (settings.syncMode === "subscribe-only") return newHead;

    const federationFilter = (linkHash: string): boolean =>
        shouldFederate(linkHash, (key) => getStorage().get(key));

    const writes = translateDiffToWrites(diff, {
        did: AT_DID,
        collection: collectionNsid(),
        settings: channelASettings(),
        neighbourhoodUrl: neighbourhoodUrl(),
        hashFn: hash,
        shouldFederate: federationFilter,
    });

    if (writes.length > 0) {
        const auth = await getAccessToken();
        if (auth) {
            const result = await xrpc.applyWrites(AT_PDS_URL, auth.accessJwt, auth.did, writes);
            if (!result.success) {
                console.error("[atproto-link-language] Channel A publish failed: applyWrites error");
            }
        } else {
            console.error("[atproto-link-language] Channel A publish failed: no auth token");
        }
    }
    return newHead;
}

// ---------------------------------------------------------------------------
// Channel-B outbound (native projection) — derived, lossy, never truth
//
// Fold the committed link additions into `app.bsky.feed.post` records via the
// SHACL projection and write them to the repo through the existing record-write
// path (applyWrites#create). No AD4M data is smuggled into the post text; these
// posts are reconstructed from Channel A on sync and are never parsed back into
// links (except genuine native-authored posts, ingested separately).
// ---------------------------------------------------------------------------

async function projectPostsRoleB(diff: PerspectiveDiff): Promise<void> {
    if (settings.rendering.strategy === "native") return;
    if (settings.syncMode === "subscribe-only") return;

    invalidateProfilesIfShapes(diff);
    const authored = diff.additions.map(toAuthoredLink);
    const projected = projectInstances<AtProtoPostRecord>(authored, projectionProfiles(), adapterFor);
    if (projected.length === 0) return;

    const auth = await getAccessToken();
    if (!auth) {
        console.error("[atproto-link-language] Channel B projection skipped: no auth token");
        return;
    }

    for (const p of projected) {
        // A distinct, deterministic-ish rkey per projected instance. The post is
        // a derived render (not an OR-Set element), so any unique rkey is fine;
        // we prefix to keep it clearly separate from substrate record keys.
        const rkey = `bsky-${tidNow()}`;
        const result = await xrpc.applyWrites(AT_PDS_URL, auth.accessJwt, auth.did, [
            {
                $type: "com.atproto.repo.applyWrites#create",
                collection: BSKY_POST_TYPE,
                rkey,
                value: p.native.value as unknown as Record<string, unknown>,
            },
        ]);
        if (!result.success) {
            console.error("[atproto-link-language] Channel B post write failed for", p.base);
        }
    }
}

// ---------------------------------------------------------------------------
// Channel-B inbound — ingest genuinely native-authored posts into Channel A
//
// A bridge's own projections are skipped by repo DID (our own repo, or any peer
// repo that converges on Channel A). Only pure-Bluesky posters — with no
// AD4M/Channel-A footprint — are ingested. No ad4m envelope is read; the SHACL
// projection maps native fields → links. Idempotent by post AT-URI, so
// re-seeing the same post never double-ingests. The resulting links are
// published on Channel A (become authoritative, folded like a local commit).
// ---------------------------------------------------------------------------

async function ingestNativePosts(): Promise<PerspectiveDiff> {
    const empty: PerspectiveDiff = { additions: [], removals: [] };
    if (settings.rendering.strategy === "native") return empty;

    const auth = await getAccessToken();
    if (!auth) return empty;

    // The DIDs we already sync (peers) are candidate post sources; a peer that
    // ALSO publishes AD4M triples is a known AD4M identity (skipped below).
    const candidateDids = store.listPeers("peers/").filter((d) => d && d !== store.getLocalDid());

    const additions: LinkExpression[] = [];
    for (const did of candidateDids) {
        // Skip repos that converge on Channel A — their posts are Channel-B echoes.
        if (isAd4mRepo(did)) continue;

        let cursor: string | undefined = undefined;
        let pages = 0;
        do {
            const res = await xrpc.listRecords(
                AT_PDS_URL,
                auth.accessJwt,
                did,
                BSKY_POST_TYPE,
                cursor,
                100,
            );
            if (!res || res.records.length === 0) break;
            for (const r of res.records) {
                if (isPostIngested(r.uri)) continue; // already ingested
                const record: AtProtoPostRecord = {
                    value: r.value as unknown as AtProtoPostRecord["value"],
                    uri: r.uri,
                    authorDid: did,
                };
                const ingested = ingestNative<AtProtoPostRecord>(
                    record,
                    projectionProfiles(),
                    adapterFor,
                );
                if (!ingested || !ingested.base) continue;

                const author = ingested.author ?? atprotoPostBase(did);
                const timestamp = ingested.timestamp ?? new Date().toISOString();
                for (const link of ingested.links) {
                    additions.push({
                        author,
                        timestamp,
                        data: { source: link.source, target: link.target, predicate: link.predicate },
                        proof: { signature: "", key: "" },
                    });
                }
                markPostIngested(r.uri);
            }
            cursor = res.cursor;
            pages++;
        } while (cursor && pages < 50);
    }

    if (additions.length === 0) return empty;

    const diff: PerspectiveDiff = { additions, removals: [] };
    await publishDiffRoleA(diff);
    return diff;
}

// ---------------------------------------------------------------------------
// Language definition
// ---------------------------------------------------------------------------

const language = defineLanguage({
    name: "@hexafield/atproto-link-language",
    version: "0.1.0",

    isPublic: true,

    async init() {
        // Initialize adapters before anything else
        initRuntime(new DenoRuntime());
        initStorage(new DenoStorageAdapter());
        initTransport(new DenoTransport());
        initSigning(new DenoSigningAdapter());
        store.initStore();

        myDid = agentDid();
        settings = parseSettings(languageSettings());

        // Bind the local repo (and thus its commit CID) to this agent's DID.
        const localRepoDid = AT_DID !== "<to-be-filled>" ? AT_DID : myDid;
        store.setLocalDid(localRepoDid);

        console.log(`[atproto-link-language] init: did=${myDid}, pds=${AT_PDS_URL}`);
        console.log(`[atproto-link-language] AT DID: ${AT_DID}`);
        console.log(`[atproto-link-language] sync mode: ${settings.syncMode}`);
        console.log(`[atproto-link-language] rendering: ${settings.rendering.strategy}`);

        // Authenticate to PDS if we have credentials
        const appPassword = AT_APP_PASSWORD !== "<to-be-filled>" ? AT_APP_PASSWORD : settings.auth.appPassword;
        if (appPassword && AT_PDS_URL !== "<to-be-filled>") {
            const handle = AT_HANDLE !== "<to-be-filled>" ? AT_HANDLE : AT_DID;
            console.log(`[atproto-link-language] attempting auth: handle=${handle}, pds=${AT_PDS_URL}`);
            try {
                const auth = await authenticate(AT_PDS_URL, handle, appPassword);
                if (auth) {
                    console.log(`[atproto-link-language] authenticated as ${auth.did}`);
                    store.setLocalDid(auth.did);
                    // Initial convergence: ride each repo's commit head via MST
                    // diff, then emit the fold through the host channel.
                    if (settings.syncMode !== "publish-only") {
                        await foldAndEmit({
                            pdsUrl: AT_PDS_URL,
                            accessJwt: auth.accessJwt,
                            repo: auth.did,
                        });
                    }
                } else {
                    console.error("[atproto-link-language] authentication failed — no session returned");
                }
            } catch (authErr: unknown) {
                console.error(`[atproto-link-language] auth error: ${authErr instanceof Error ? authErr.message : String(authErr)}`);
            }
        }
    },

    async teardown() {
        myDid = "";
        console.log("[atproto-link-language] teardown");
    },

    // -----------------------------------------------------------------------
    // perspective-commit
    //
    // Channel A (source of truth): advance the local MST commit chain and
    // publish the substrate records — additions become ad4m.link.triple,
    // removals become ad4m.link.tombstone carrying the original link hash. This
    // advances the local commit CID (the new revision) and federates the WHOLE
    // perspective, every link and all SDNA, independent of rendering strategy.
    //
    // Channel B (derived native projection): unless rendering is "native",
    // detected projectable instances (Flux messages, or any SHACL-annotated
    // subject class) are ALSO rendered as human-readable app.bsky.feed.post
    // records for native Bluesky clients — with NO AD4M data smuggled into the
    // post text. This projection is reconstructed from Channel A on sync, never
    // parsed back into links.
    // -----------------------------------------------------------------------
    commit: {
        async commit(diff: PerspectiveDiff) {
            // Channel A — advance the substrate + publish triples/tombstones.
            const newHead = await publishDiffRoleA(diff);

            if (settings.syncMode === "subscribe-only") {
                emitPerspectiveDiff(diff);
                return newHead;
            }

            // Channel B — derived native projection (post records).
            await projectPostsRoleB(diff);

            // Emit perspective diff for local subscribers.
            emitPerspectiveDiff(diff);

            // The new revision is the local repo's advanced commit CID.
            return newHead;
        },
    },

    // -----------------------------------------------------------------------
    // perspective-sync
    //
    // Channel A: ride each participating repo's commit head (self + peers) via
    // MST diff, converge via the cross-repo OR-Set, and fold the delta.
    //
    // Channel B: after folding Channel A, ingest genuinely native-authored posts
    // — from repos/DIDs with NO AD4M/Channel-A footprint — as NEW authoritative
    // links (published back onto Channel A). Our own posts and other bridges'
    // posts are suppressed by repo DID; already-ingested posts by AT-URI.
    // -----------------------------------------------------------------------
    sync: {
        async sync() {
            // Skip sync in publish-only mode
            if (settings.syncMode === "publish-only") {
                return { additions: [], removals: [] };
            }

            const auth = await getAccessToken();
            if (!auth) {
                return { additions: [], removals: [] };
            }

            // Channel A — fold the authoritative substrate AND push the delta
            // through emitPerspectiveDiff. The executor discards this handler's
            // return value, so a returned-but-unemitted fold leaves peer links
            // invisible to queryLinks (the A=10/B=10 freeze); foldAndEmit closes
            // that loop. See src/sync.ts.
            const diff = await foldAndEmit({
                pdsUrl: AT_PDS_URL,
                accessJwt: auth.accessJwt,
                repo: auth.did,
            });

            // Channel B — ingest pure-Bluesky posts into Channel A as new links.
            // Native ingests are published back onto Channel A, so they surface
            // (and emit) on the next fold; combine them into the return for any
            // caller that does consume it.
            const ingested = await ingestNativePosts();

            if (ingested.additions.length === 0 && ingested.removals.length === 0) {
                return diff;
            }
            if (ingested.additions.length > 0 || ingested.removals.length > 0) {
                emitPerspectiveDiff(ingested);
            }
            return {
                additions: [...diff.additions, ...ingested.additions],
                removals: [...diff.removals, ...ingested.removals],
            };
        },

        async render() {
            // Role B projection: derived from the substrate fold, never read
            // back from a materialised store.
            return store.allLinks();
        },

        async currentRevision() {
            // The version-vector digest of every participating repo's commit
            // CID head (or the single commit CID when solo) — a real content
            // hash, deterministic and stable across restarts for the same state.
            return store.getRevision();
        },
    },

    // -----------------------------------------------------------------------
    // perspective-query
    // -----------------------------------------------------------------------
    query: {
        supportedKinds() {
            return ["link-pattern"];
        },

        async run(req: { kind: string; payload: unknown }) {
            if (req.kind !== "link-pattern") {
                return { kind: "error", payload: `Unsupported query kind: ${req.kind}` };
            }
            const pattern = req.payload as { source?: string; target?: string; predicate?: string };
            const links = store.queryLinks(pattern);
            return { kind: "links", payload: links };
        },
    },

    // -----------------------------------------------------------------------
    // peers
    // -----------------------------------------------------------------------
    peers: {
        setLocal(agents: string[]) {
            for (const did of agents) {
                store.setPeer(did, { local: true });
            }
        },

        async remote() {
            return store.listPeers("peers/");
        },
    },
});

// ---------------------------------------------------------------------------
// Flat exports
// ---------------------------------------------------------------------------

export const {
    name,
    version,
    isPublic,
    init,
    teardown,
    perspectiveCommit,
    perspectiveSyncSync,
    perspectiveSyncRender,
    perspectiveSyncCurrentRevision,
    perspectiveQuerySupportedKinds,
    perspectiveQueryRun,
    peersSetLocal,
    peersRemote,
} = language;

export default language;

// ---------------------------------------------------------------------------
// Callback registration
// ---------------------------------------------------------------------------

let linkCallback: ((diff: PerspectiveDiff) => void) | null = null;
let syncStateChangeCallback: ((state: string) => void) | null = null;

export function linkSyncAddCallback(callback: (diff: PerspectiveDiff) => void): number {
    linkCallback = callback;
    return 1;
}

export function linkSyncRemoveCallback(callback: (diff: PerspectiveDiff) => void): number {
    if (linkCallback === callback) linkCallback = null;
    return 1;
}

export function linkSyncAddSyncStateChangeCallback(callback: (state: string) => void): number {
    syncStateChangeCallback = callback;
    return 1;
}

// ---------------------------------------------------------------------------
// Signal handler
// ---------------------------------------------------------------------------

/**
 * Handle signals emitted by the executor.
 *
 * The executor may forward an inbound record from a peer repo (triple add or
 * tombstone removal) as a signal. We ingest it into that peer's repo state
 * (the cross-repo OR-Set substrate), then emit the resulting fold delta — the
 * links that entered or left the materialised set. Convergence is the OR-Set
 * union, not a direct apply of the inbound link.
 */
export async function handleSignal(signalData: string): Promise<void> {
    let signal: unknown;
    try {
        signal = JSON.parse(signalData);
    } catch {
        return; // Not JSON — not our signal
    }

    if (typeof signal !== "object" || signal === null) return;
    const s = signal as Record<string, unknown>;
    if (s.type !== "atproto:record") return;

    const record = s.record as { uri: string; cid: string; value: Record<string, unknown> } | undefined;
    if (!record) return;

    const { splitPath } = await import("./src/mst.js");
    const stripped = record.uri.replace("at://", "");
    const slash = stripped.indexOf("/");
    const authorDid = slash >= 0 ? stripped.slice(0, slash) : stripped;
    const pathPart = slash >= 0 ? stripped.slice(slash + 1) : "";
    const { collection, rkey } = splitPath(pathPart);
    if (!authorDid || !collection || !rkey) return;

    // Snapshot before → ingest into the peer repo → snapshot after → emit delta.
    const before = new Map(store.foldLinks().map((l) => [store.hashLink(l), l] as const));
    store.ingestPeerRecords(
        authorDid,
        [{ collection, rkey, value: record.value }],
        [],
        record.cid || null,
    );
    const after = new Map(store.foldLinks().map((l) => [store.hashLink(l), l] as const));

    const additions: LinkExpression[] = [];
    const removals: LinkExpression[] = [];
    for (const [h, l] of after) if (!before.has(h)) additions.push(l);
    for (const [h, l] of before) if (!after.has(h)) removals.push(l);

    if (additions.length === 0 && removals.length === 0) return;
    const diff: PerspectiveDiff = { additions, removals };
    if (linkCallback) linkCallback(diff);
}
