# The Moss SDK, as Osade uses it

The package is **`@moss-js/moss`** (1.11.0 at the time of writing). `@moss-dev/moss` is the
frozen 1.7.1 predecessor and is *not* what Osade builds against — an earlier version of this
file documented that package and its `createIndex` / `loadIndex` API, which no longer matches
anything in the tree.

For the full reference see [`docs-moss.md`](./docs-moss.md) or
<https://docs.moss.dev/docs/reference/js/api>. This file records only what Osade depends on and
what was verified by probing the installed package, because two of those facts contradict the
published docs.

## What Osade uses

One session per namespace, all local:

```ts
const client = new MossClient(projectId, projectKey);
const session = await client.session('osade.<installId>.turns', 'moss-minilm');

await session.addDocs(docs, { upsert: true });
await session.deleteDocs(ids);
const { docs: hits } = await session.query(text, { topK, alpha, filter });
```

Every one of those runs in process memory with no cloud round trip. `pushIndex()` exists and
Osade **never calls it** unless `retrieval.cloudSync` is set — transcripts, code chunks and
policy text do not leave the machine by default (OSADE-MOSS §M.1.3).

## Two things the published docs get wrong

**`saveToDisk` and `loadFromDisk` exist.** The Sessions page does not mention them, which led to
an early decision here to rebuild the index from SQLite on every boot. Probing
`SessionIndex.prototype` shows both, each taking a directory path. Osade uses them for the
§M.1.3 warm boot, with a cursor stamped beside the snapshot so a stale index can never be
mistaken for a current one.

**The metadata filter is not the flat MongoDB shape.** A condition is
`{ field, condition: { $eq } }`; a single condition is passed bare, and several are composed
under `$and`. The operators are `$eq $ne $gt $gte $lt $lte $in $nin $near`. Osade translates its
own narrower filter type in `retrieval/moss-adapter.ts` and nowhere else.

## Facts that shape the design

- **Metadata values are strings.** Whether comparisons are numeric or lexical is left open by
  the docs (§M.12 Q3), so Osade zero-pads every sortable key to twelve digits — `seq` and `at`
  — which makes both answers correct.
- **`alpha` blends semantic and keyword scoring**: 1.0 pure semantic, 0.0 pure keyword, 0.8 the
  default. Osade sets it per namespace (§M.1.6); `code` uses 0.5 because identifiers carry half
  the signal.
- **Credentials are validated when a session is opened**, which is why Osade opens all five at
  boot rather than on the first agent turn — that turn is on the hot path.
- **The free Developer plan allows 3 cloud indexes per project.** Un-pushed sessions are local,
  and whether they count against that limit is unverified (§M.12 Q1). If they do, the adapter
  collapses to one session with a mandatory `ns` filter; the port does not change.

## The seam

`@moss-js/moss` may be imported only under `packages/daemon/src/retrieval/**`, and in practice
only by `moss-adapter.ts`. That is lint-enforced and covered by `lint-rules.test.ts`. The
adapter loads the SDK through a dynamic import so a missing package or an unbuildable native
addon degrades to SQLite FTS5 rather than failing daemon startup (§M.10).
