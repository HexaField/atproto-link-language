/**
 * Cross-repo OR-Set — multi-agent convergence for ATProto.
 *
 * Each agent writes AD4M links into **its own PDS repo**. There is no shared
 * repo and no merge coordinator, so the perspective's link set is the
 * **union across all participating repos**, resolved as an **OR-Set
 * (observed-remove set) keyed by link content-hash** (spec §2.3 default for
 * cross-repo protocols).
 *
 * Why an OR-Set converges here with no scribe: a link's content-hash covers
 * its full triple + author + timestamp, so the *same* link has the *same*
 * hash in every repo, and two different links can never collide. Therefore:
 *
 *   - An **add** contributes the link's hash `h` (observed) to the set.
 *   - A **removal** is a first-class **tombstone record** that carries the
 *     ORIGINAL link hash `h` (spec §2.4) — so a delete in repo B converges
 *     against the add in repo A.
 *   - **Merge** = union of all adds, minus the union of all tombstones.
 *
 * The whole thing is set algebra (union + difference), which is commutative
 * and associative, so the fold is **order-independent by construction** —
 * feeding repos / records in any order yields the same link set and the same
 * version-vector revision.
 */

// ---------------------------------------------------------------------------
// Per-repo contribution
// ---------------------------------------------------------------------------

/**
 * What a single repo contributes to the shared OR-Set, expressed purely as
 * content-addressed link hashes.
 *
 *   - `adds`       — link hashes this repo asserts present (its `ad4m.link.*`
 *                    records).
 *   - `tombstones` — link hashes this repo has tombstoned (its
 *                    `ad4m.link.tombstone` records, each carrying an original
 *                    link hash).
 */
export interface RepoContribution {
    adds: Set<string>;
    tombstones: Set<string>;
}

/** Create an empty contribution. */
export function emptyContribution(): RepoContribution {
    return { adds: new Set(), tombstones: new Set() };
}

/**
 * The resolved OR-Set: the set of link hashes present after folding all
 * repos (`present`), plus the raw union of adds and tombstones (kept so the
 * revision can be a version-vector-style digest, and so add-after-remove can
 * be reasoned about explicitly).
 */
export interface OrSetResult {
    present: Set<string>;
    allAdds: Set<string>;
    allTombstones: Set<string>;
}

/**
 * Fold any number of per-repo contributions into a single OR-Set.
 *
 * `present = (⋃ adds) \ (⋃ tombstones)`.
 *
 * A tombstone removes a link even if the matching add lives in a *different*
 * repo (cross-repo removal). This is the default OR-Set / "remove-wins on the
 * observed hash" semantics: to re-assert a tombstoned link, an agent writes a
 * *new* link (new timestamp ⇒ new hash), which is not covered by the old
 * tombstone. Because both operands are sets, the fold commutes and is
 * associative — order-independent.
 */
export function foldOrSet(contributions: Iterable<RepoContribution>): OrSetResult {
    const allAdds = new Set<string>();
    const allTombstones = new Set<string>();
    for (const c of contributions) {
        for (const h of c.adds) allAdds.add(h);
        for (const h of c.tombstones) allTombstones.add(h);
    }
    const present = new Set<string>();
    for (const h of allAdds) {
        if (!allTombstones.has(h)) present.add(h);
    }
    return { present, allAdds, allTombstones };
}

// ---------------------------------------------------------------------------
// Version-vector revision digest
// ---------------------------------------------------------------------------

/**
 * A digest of the multi-writer head set — used as `currentRevision()` when
 * the perspective spans multiple repos and there is no single commit head.
 *
 * Per spec §2, a multi-writer protocol with no single head returns a
 * **deterministic hash of the set of per-writer head hashes** (a version
 * vector digest). We build it by sorting the `did → commitCid` pairs and
 * hashing the canonical concatenation with the provided content-hash
 * function (the same `hash()` used for links, so the digest lives in the
 * same address space and is stable across restarts for the same heads).
 */
export function versionVectorDigest(
    heads: Map<string, string>,
    hashFn: (data: string) => string,
): string {
    const pairs = [...heads.entries()]
        .filter(([, cid]) => !!cid)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (pairs.length === 0) return "";
    if (pairs.length === 1) return pairs[0][1];
    const canonical = pairs.map(([did, cid]) => `${did}=${cid}`).join("\n");
    return hashFn(canonical);
}
