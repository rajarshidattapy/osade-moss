> ## Documentation Index
> Fetch the complete documentation index at: https://docs.moss.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# Overview

> Everything the Moss JavaScript SDK can do, with a snippet for each operation.

The Moss JavaScript SDK (`@moss-js/moss`) brings semantic search to Node.js. It wraps a
high-performance Rust core and exposes an async, Promise-based API. Documents are embedded
and queried locally, with optional cloud sync.

## Requirements

* Node.js 20.4 or higher

## Install

```bash theme={null}
npm install @moss-js/moss
```

<Note>
  Versions below 1.9.0 will stop loading models when the legacy download path is retired. Upgrade to 1.9.0+ before then.
</Note>

<Note>
  Moss for Node moved from `@moss-dev/moss` to `@moss-js/moss` with 1.8.0. `@moss-dev/moss` is a frozen 1.7.1 package. Versions below 1.9.0 will stop loading models when the legacy download path is retired. Upgrade to `@moss-js/moss` 1.9.0+ before then. The date will be announced in the changelog. `@moss-dev/moss-web` is the browser SDK and is not this package.
</Note>

Get your `projectId` and `projectKey` from the [Moss portal](https://portal.usemoss.dev).

## Two ways to search

* [`MossClient`](./classes/MossClient) - the entry point. Manage cloud indexes, load one into memory, and query it.
* [`SessionIndex`](./classes/SessionIndex) - a local, in-process index for real-time indexing during a live interaction; push to the cloud when done.

## Quick start

```typescript theme={null}
import { MossClient } from '@moss-js/moss'

const client = new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!)

await client.createIndex('faqs', [
  { id: 'doc1', text: 'Track your order in your account.', metadata: { category: 'shipping' } },
  { id: 'doc2', text: '30-day return policy for most items.', metadata: { category: 'returns' } },
])
await client.loadIndex('faqs')
const results = await client.query('faqs', 'return a damaged product', { topK: 3 })
results.docs.forEach(d => console.log(d.id, d.score))
```

## Indexes

Create, inspect, and delete cloud indexes. Mutations run as async jobs and return a
`MutationResult` with a `jobId` and `docCount`.

```typescript theme={null}
// Create (defaults to moss-minilm)
const result = await client.createIndex('faqs', documents)

// Inspect
const info = await client.getIndex('faqs')   // IndexInfo: name, docCount, model.id, status
const indexes = await client.listIndexes()    // IndexInfo[]

// Delete
await client.deleteIndex('faqs')
```

## Index from files

Build an index straight from PDF and DOCX files - the server parses, chunks, and embeds
them. Up to 20 files per call.

```typescript theme={null}
await client.createIndexFromFiles('contracts', [
  { name: 'report.pdf', contentType: 'application/pdf', path: '/docs/report.pdf' },
], { parseOptions: { ocrMode: 'full_ocr' } })
```

See [Index from files](./files).

## Documents

Add, update, fetch, and remove documents on an existing index.

```typescript theme={null}
// Add or upsert
await client.addDocs('faqs', newDocs, { upsert: true })

// Fetch all, or by id
const allDocs = await client.getDocs('faqs')
const some = await client.getDocs('faqs', { docIds: ['doc1', 'doc2'] })

// Delete by id
await client.deleteDocs('faqs', ['doc6', 'doc7'])
```

## Load and query

Load an index into memory, then query it in-process. Call `loadIndex` before querying.

```typescript theme={null}
await client.loadIndex('faqs')
const results = await client.query('faqs', 'return a damaged product', { topK: 3 })
results.docs.forEach(d => console.log(d.id, d.score, d.text))
```

## Hybrid search

Blend semantic and keyword scoring with `alpha` (1.0 = semantic, 0.0 = keyword; default 0.8).

```typescript theme={null}
await client.query('faqs', 'return policy', { topK: 3, alpha: 0.6 })
```

See [Hybrid search](./hybrid-search).

## Metadata filtering

Narrow results by document metadata on a loaded index.

```typescript theme={null}
await client.query('products', 'running shoes', {
  topK: 5,
  filter: {
    $and: [
      { field: 'category', condition: { $eq: 'shoes' } },
      { field: 'price',    condition: { $lt: 100 } },
    ],
  },
})
```

Operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$near`, composed with
`$and` / `$or`. See [Metadata filtering](./metadata-filtering).

## Custom embeddings

Supply your own vectors with `modelId: 'custom'` (each document carries `embedding`, and
queries pass `embedding`).

```typescript theme={null}
await client.createIndex('tickets', docsWithEmbeddings, { modelId: 'custom' })
await client.loadIndex('tickets')
await client.query('tickets', 'billing problem', { topK: 3, embedding: queryVector })
```

See [Custom embeddings](./custom-embeddings).

## Sessions

Index and query locally in real time with a [`SessionIndex`](./classes/SessionIndex), then
push to the cloud. `session()` resumes an existing cloud index by name, or starts empty.

```typescript theme={null}
const session = await client.session('call-123')
await session.addDocs([{ id: 'turn-1', text: 'Customer reported a duplicate charge.' }])
const hits = await session.query('billing issue', { topK: 3 })
await session.pushIndex()
```

See [Sessions](./sessions).

## Keeping indexes fresh

Auto-refresh a loaded index (poll the cloud and hot-swap newer versions in automatically),
and track async jobs.

```typescript theme={null}
await client.loadIndex('faqs', { autoRefresh: true, pollingIntervalInSeconds: 300 })
const status = await client.getJobStatus(result.jobId)
```

## Authentication

Construct the client with a `projectKey` for server-side use, or use a custom authenticator
to mint short-lived tokens for untrusted clients (`getAuthToken()`).

```typescript theme={null}
const { token, expiresIn } = await client.getAuthToken()
```

See [Custom Authenticator](./custom-authenticator).

## Models

* `moss-minilm` (default) - fast, lightweight
* `moss-mediumlm` - higher accuracy
* `custom` - supply your own embedding vectors via `DocumentInfo.embedding`

## Guides

* [Index from files](./files)
* [Sessions](./sessions)
* [Hybrid search](./hybrid-search)
* [Metadata filtering](./metadata-filtering)
* [Custom embeddings](./custom-embeddings)
* [Custom Authenticator](./custom-authenticator)

## Reference

[MossClient](./classes/MossClient) and [SessionIndex](./classes/SessionIndex), plus all interfaces and types, are in the Reference section of the sidebar.


> ## Documentation Index
> Fetch the complete documentation index at: https://docs.moss.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# Index from Files

> Build an index from PDF and DOCX files with server-side parsing.

`createIndexFromFiles` builds a new index directly from raw documents. You upload PDF and DOCX
files; the server parses them, splits them into chunks, generates embeddings, and builds the
index. The call resolves when the index is ready to query.

<Note>
  Requires `@moss-js/moss` **1.8.0+**. Also available in Python as
  `create_index_from_files` (`moss` **1.7.3+**).
</Note>

```typescript theme={null}
import { MossClient } from '@moss-js/moss'

const client = new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!)

await client.createIndexFromFiles('contracts', [
  { name: 'report.pdf', contentType: 'application/pdf', path: '/docs/report.pdf' },
  {
    name: 'manual.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data: docxBytes, // Uint8Array, Buffer, ArrayBuffer, Blob, or File
  },
], {
  parseOptions: { ocrMode: 'full_ocr' }, // scanned documents with no text layer
  onProgress: (p) => console.log(p.status, p.currentPhase, `${p.progress}%`),
})

// Query the new index server-side right away - no loadIndex needed
const results = await client.query('contracts', 'termination clause')
```

## How it works

The call handles the full flow: it registers the files, uploads each one, and triggers
parsing, embedding, and the index build server-side. It polls the job every \~2 seconds
(reporting through `onProgress`) and resolves to a
[`MutationResult`](./interfaces/MutationResult) when the index is ready. Jobs time out after
30 minutes.

## Files

Each entry is a [`ParseFileInput`](./interfaces/ParseFileInput):

| Field         | Required               | Notes                                                                                                                                                                              |
| ------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Yes                    | Identifier for the file. Names must be unique within the call - uploads are matched back to files by name.                                                                         |
| `contentType` | Yes                    | `application/pdf` or `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX). Not inferred from the file name; any other value is rejected before upload. |
| `path`        | One of `path` / `data` | Filesystem path (Node.js).                                                                                                                                                         |
| `data`        | One of `path` / `data` | In-memory bytes: `Uint8Array`, `Buffer`, `ArrayBuffer`, `Blob`, or `File`. Takes precedence over `path` when both are set.                                                         |

Limits:

* 1 to 20 files per call. Each call creates a new index, and files cannot be appended to an
  existing index afterwards, so an index is built from at most 20 files.
* 50 MB per file, enforced server-side. The SDK does not pre-check size; an oversized file
  fails during the job.
* Prefer `path` on Node.js. In-memory `data` is copied byte by byte across the native
  boundary, which is memory-hungry for large files.

## Options

[`CreateIndexFromFilesOptions`](./interfaces/CreateIndexFromFilesOptions):

| Option          | Notes                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `modelId?`      | `"moss-minilm"` (default) or `"moss-mediumlm"`. `"custom"` is not supported - the server generates embeddings during parsing. |
| `parseOptions?` | Extraction controls, below.                                                                                                   |
| `onProgress?`   | Callback invoked with progress updates (\~every 2s) while the server is processing.                                           |

### Parse options

All fields of [`ParseOptions`](./interfaces/ParseOptions) are optional; omitted fields use the
server defaults.

| Option               | Values                                         | What it does                                                                                                                                     |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ocrMode`            | `"auto_ocr"` \| `"full_ocr"`                   | `full_ocr` forces OCR on every page, which is what scanned documents with no text layer need. `auto_ocr` runs OCR only where it looks necessary. |
| `useHighResolution`  | boolean                                        | Slower, higher-fidelity extraction. Useful for dense tables.                                                                                     |
| `segmentationMethod` | `"smart_layout_detection"` \| `"page_by_page"` | How the document is segmented before extraction.                                                                                                 |
| `mergeTables`        | boolean                                        | Merge a table split across a page break into a single segment.                                                                                   |

## Progress

`onProgress` receives a [`JobProgress`](./interfaces/JobProgress) roughly every 2 seconds
while the server is working (there is no per-byte upload progress):

```typescript theme={null}
{
  jobId: string,
  status: 'pending_upload' | 'uploading' | 'building' | 'completed' | 'failed',
  progress: number, // 0-100
  currentPhase: JobPhase | null
}
```

File-parse jobs move through the phases `queued`, `parsing`, `waiting_for_parser`,
`parsing_complete`, `generating_embeddings`, and `building_index`. Guard phase checks with
`if (p.currentPhase)` - it can be unset on some events. Progress is advisory; the awaited
promise is the authoritative signal.

## What gets indexed

Documents are parsed into retrieval-sized chunks with layout awareness. Repeating page
headers, footers, and page numbers are excluded from the indexed text. A scanned or
image-only document produces no readable text unless OCR runs - if a file fails with
"No readable text was found", retry with `parseOptions: { ocrMode: 'full_ocr' }`.

## Querying a parse-built index

Query the index without loading it - `client.query(name, text)` runs server-side when the
index is not loaded locally:

```typescript theme={null}
const results = await client.query('contracts', 'termination clause', { topK: 5 })
```

<Warning>
  Local text queries are not yet supported for parse-built indexes: after `loadIndex()`, a
  plain text `query()` throws. Either query without loading the index, or pass your own query
  embedding via `QueryOptions.embedding`.
</Warning>

## Errors

Failures throw a plain `Error`. Common messages:

| Message starts with                                                            | Cause                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `Validation error: files must not exceed 20`                                   | More than 20 files in one call.                 |
| `Validation error: Unsupported content type`                                   | `contentType` is not PDF or DOCX.               |
| `Validation error: create_index_from_files does not support model_id='custom'` | `modelId: 'custom'` was passed.                 |
| `Model not allowed:`                                                           | The model is not enabled for your organization. |
| `Upload failed:`                                                               | A file could not be read or uploaded.           |
| `Job failed:`                                                                  | Parsing or the index build failed server-side.  |
| `Job timed out after 1800 seconds`                                             | The job exceeded the 30 minute polling ceiling. |

## Python

```python theme={null}
from moss import MossClient, ParseFileInput, ParseOptions

client = MossClient(project_id, project_key)
await client.create_index_from_files("contracts", [
    ParseFileInput(name="report.pdf", content_type="application/pdf", path="/docs/report.pdf"),
], parse_options=ParseOptions(ocr_mode="full_ocr"))
```

Same behavior and limits; there is no progress callback in Python. See the
[Python guide](../python/files).

## Browser

`@moss-dev/moss-web` also exposes `createIndexFromFiles`, with a reduced surface: files must
supply `data` as a `Uint8Array` (no `path`), and `parseOptions` and progress reporting are
not available. See [Browser vs Node](../browser/browser-vs-node).


> ## Documentation Index
> Fetch the complete documentation index at: https://docs.moss.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# Web Sources

> Crawl websites into an index and keep them fresh.

A web source crawls a website into an index and keeps it up to date. The `MossClient` web
source methods are typed wrappers over the [`/v1/manage` web source
actions](/docs/api-reference/v1/web-sources/createWebSource): each call goes to the Moss
cloud API with your project key, needs no index loaded locally, and works wherever the SDK
runs.

<Note>
  Requires `@moss-js/moss` **1.10.0+**. Also available in Python as
  [`create_web_source`](../python/web-sources) and the other web source methods (`moss`
  **1.10.0+**). Crawling, manual re-sync, and scheduled refresh are plan gated; see
  [Pricing](/docs/pricing).
</Note>

```typescript theme={null}
import { MossClient, ManageApiError } from '@moss-js/moss'

const client = new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!)

async function waitForJob(jobId: string) {
  for (;;) {
    const job = await client.getJobStatus(jobId)
    if (job.status === 'completed') return
    if (job.status === 'failed') throw new Error(`job failed: ${job.error ?? ''}`)
    await new Promise((r) => setTimeout(r, 5000))
  }
}

// Two sites, one index. The first call creates the index; the second adds to it.
const docs = await client.createWebSource('https://docs.yoursite.com', 'support-kb', {
  maxPages: 500,
  maxDepth: 3,
  refreshCadence: 'weekly',
})
const blog = await client.createWebSource('https://blog.yoursite.com', 'support-kb', {
  maxPages: 200,
})
await waitForJob(docs.jobId)
await waitForJob(blog.jobId)

await client.loadIndex('support-kb')
const results = await client.query('support-kb', 'how do I rotate an API key')
```

## Methods

| Method                                          | Returns                                          | What it does                                                                                   |
| ----------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `createWebSource(rootUrl, indexName, options?)` | [`CreateWebSourceResult`](#the-websource-record) | Registers the site on the index and starts a crawl. `jobId` polls the crawl.                   |
| `listWebSources(indexName?)`                    | `WebSource[]`                                    | Every source in the project, newest first, or only the sources on one index.                   |
| `getWebSource(sourceId)`                        | `WebSource`                                      | One source with its settings, schedule, and last-run stats.                                    |
| `updateWebSource(sourceId, options)`            | `UpdateWebSourceResult`                          | Changes settings or cadence. With `resync: true` a crawl starts right away and `jobId` is set. |
| `resyncWebSource(sourceId)`                     | `ResyncWebSourceResult`                          | Re-crawls one source. `jobId` polls the crawl.                                                 |
| `deleteWebSource(sourceId)`                     | `DeleteWebSourceResult`                          | Removes the source and its pages. `purgeJobId` polls the removal. The index is kept.           |

These methods need the project key. A client built with a custom authenticator instead of a
key throws `Web source methods require a project key`.

## Several sites on one index

* An index holds up to 20 web sources. Each root URL can be registered once per index; the
  URL with and without a trailing slash is the same source, and a repeat is refused with
  status 409.
* Each source's pages are tracked separately. A crawl or re-sync replaces only that source's
  pages, and `deleteWebSource` removes only that source's pages. Other sources and documents
  added with `addDocs` are never touched.
* Crawls on the same index run one at a time. A crawl requested while another runs queues
  and starts on its own; you do not need to wait between `createWebSource` calls.
* Every source on an index uses the index's embedding model, fixed when the index is
  created.

## Create options

`CreateWebSourceOptions`, all optional:

| Option           | Default         | Notes                                                                        |
| ---------------- | --------------- | ---------------------------------------------------------------------------- |
| `maxPages`       | `500`           | Page cap per crawl run, max `5000`. Your plan's crawl size caps it further.  |
| `maxDepth`       | `3`             | Link depth from `rootUrl`, max `10`.                                         |
| `maxDocuments`   | `50000`         | Cap on indexed chunks.                                                       |
| `includePaths`   | none            | Only crawl matching path globs, e.g. `['/blog/*']`. Up to 50.                |
| `excludePaths`   | none            | Skip matching path globs. Up to 50.                                          |
| `respectRobots`  | `true`          | Honor robots.txt.                                                            |
| `parseDocuments` | `true`          | Parse linked PDF and DOCX files into the index (50 MB per file, 20 per run). |
| `refreshCadence` | none            | `'daily'` or `'weekly'` for scheduled re-crawls. Omit for a manual source.   |
| `modelId`        | `'moss-minilm'` | Or `'moss-mediumlm'`. Only used when the index is created.                   |

## Update options

`UpdateWebSourceOptions`. Fields you leave out stay
unchanged; crawl settings apply on the next crawl.

| Option                         | Notes                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `refreshCadence`               | `'daily'`, `'weekly'`, or `'manual'`. Changing it resets the schedule to now plus the interval. |
| `rootUrl`                      | Re-point the source. The next crawl indexes the new site and drops the old site's pages.        |
| `includePaths`, `excludePaths` | Path globs. Pass `[]` to clear.                                                                 |
| `maxDepth`, `maxPages`         | New caps for future crawls.                                                                     |
| `resync`                       | `true` starts a crawl after saving; the result carries `jobId`.                                 |

Crawl settings cannot change while the source is crawling (status 409); the cadence can.
`maxDocuments`, `respectRobots`, and `parseDocuments` are changed through the
[`updateWebSource` API action](/docs/api-reference/v1/web-sources/updateWebSource).

## The WebSource record

Every method except delete returns a `WebSource`:

| Field                                                                                                       | Notes                                                                                                                |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                                                        | Source ID, used by the other methods.                                                                                |
| `indexName`, `rootUrl`                                                                                      | The index and the registered URL (a bare origin gains a trailing slash).                                             |
| `maxPages`, `maxDocuments`, `maxDepth`, `includePaths?`, `excludePaths?`, `respectRobots`, `parseDocuments` | Crawl settings.                                                                                                      |
| `refreshCadence`, `nextRefreshAt`                                                                           | `'daily'`, `'weekly'`, or `'manual'`, and when the next scheduled run is due (`null` for manual).                    |
| `status`                                                                                                    | `'crawling'` while a run is queued or active, `'idle'`, `'failed'`, or `'removing'` while a delete purges its pages. |
| `lastCrawledAt`, `lastPageCount`, `lastDocCount`                                                            | Stats from this source's last completed run.                                                                         |
| `lastErrorCode`                                                                                             | Moss error code from the last failed run, or `null`.                                                                 |

`CreateWebSourceResult` adds `jobId`. `UpdateWebSourceResult` adds `jobId` when `resync` was
`true`. `ResyncWebSourceResult` is `{ id, jobId, status }`. `DeleteWebSourceResult` is
`{ deleted, id, purgeJobId? }`; `purgeJobId` is absent when there was nothing to purge, for
example when the index was already deleted.

## Polling jobs

Crawl and purge jobs are polled with `getJobStatus(jobId)`, which resolves to a
[`JobStatusResponse`](./interfaces/JobStatusResponse). `status` ends at `'completed'` or
`'failed'`. `currentPhase` moves through `'queued'` (waiting for another crawl or build on
the index), `'crawling'`, `'parsing_documents'` when linked files were found, and
`'building_index'`. A queued crawl reports `status: 'building'` with
`currentPhase: 'queued'`.

## Errors

Every method throws `ManageApiError` with the HTTP `status` and the
API's JSON error body in the message, which includes the Moss error code.

| `status` | Error code                  | Cause                                                                                                                  |
| -------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `400`    | `VALIDATION_FAILED`         | A limit out of range, a non-public `rootUrl`, an unsupported `modelId`, a `null` field, or a 21st source on the index. |
| `403`    | `PLAN_FEATURE_NOT_INCLUDED` | Scheduled refresh or manual re-sync is not on your plan.                                                               |
| `404`    | `WEB_SOURCE_NOT_FOUND`      | Unknown `sourceId`.                                                                                                    |
| `409`    | `WEB_SOURCE_EXISTS`         | The root URL is already registered on this index.                                                                      |
| `409`    | `BUILD_IN_PROGRESS`         | Crawl settings changed, a re-sync requested, or a delete attempted while the source is crawling.                       |
| `429`    | `USAGE_LIMIT_EXCEEDED`      | Concurrent job, crawled URL, index, or credit limits.                                                                  |
| `503`    |                             | Crawling or the plan check is temporarily unavailable.                                                                 |

```typescript theme={null}
try {
  await client.createWebSource('https://docs.yoursite.com', 'support-kb')
} catch (e) {
  if (e instanceof ManageApiError && e.status === 409) {
    // already registered on this index
  } else {
    throw e
  }
}
```

## Environment

`MOSS_CLOUD_API_BASE_URL` overrides the API host used by the web source methods (default
`https://service.usemoss.dev`). It does not affect the client's other calls.


> ## Documentation Index
> Fetch the complete documentation index at: https://docs.moss.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# Sessions

> Local-first, real-time indexing in JavaScript with create-resume-query-push.

A session is a local index you read and write in real time, with no cloud round trip on any
operation. Sessions are how Moss indexes data during a live interaction - indexing transcript
turns mid-call, building a per-user working set, or accumulating context that is handed off
between agents.

A session is a [`SessionIndex`](./classes/SessionIndex), created from
[`client.session()`](./classes/MossClient#session). It works with a client built with either a
`projectKey` or a custom authenticator (the session authenticates through the same bridge as
[`loadIndex`](./classes/MossClient#loadindex)).

## Create or resume

`client.session(name)` returns a `SessionIndex`. If a cloud index with that name already
exists it auto-loads into the session (no re-embedding); otherwise the session starts empty.
The workflow is identical in both cases, and `name` is also the target when
[`pushIndex()`](./classes/SessionIndex#pushindex) is called.

```typescript theme={null}
import { MossClient } from '@moss-js/moss'

const client = new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!)

// Create or resume by name.
const session = await client.session('call-123')
console.log(`${session.docCount} existing docs loaded`)

// Mutate locally - appended to whatever was loaded. Embeds in-process, no network.
await session.addDocs([
  { id: 'turn-1', text: 'Customer reported a duplicate charge on their March invoice.' },
])

// Query locally (~1-10ms). Same options as MossClient.query (topK, alpha, filter, embedding).
const results = await session.query('billing issue', { topK: 3 })
results.docs.forEach(d => console.log(d.id, d.score, d.text))

// Fetch and delete by id, also local.
const docs = await session.getDocs({ docIds: ['turn-1'] })
await session.deleteDocs(['turn-1'])

// Persist to the cloud under the session name (no server-side re-embedding).
const pushed = await session.pushIndex()
console.log(`Pushed ${pushed.docCount} docs (job ${pushed.jobId})`)
```

## Short-term vs. long-term context

A session is short-term context - the working set for the current interaction. A persistent
cloud index loaded with [`client.loadIndex()`](./classes/MossClient#loadindex) is long-term
context - durable knowledge shared across interactions. Most real-time apps query both: load
a cloud index for long-term knowledge, open a session for the live turns, and query each.

```typescript theme={null}
import { MossClient } from '@moss-js/moss'

const client = new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!)

// Long-term context: load a persistent cloud index into memory.
await client.loadIndex('product-faqs')

// Short-term context: open a session for the live call.
const session = await client.session('call-123')

// As the call progresses, index transcript turns locally.
await session.addDocs([
  { id: 'turn-1', text: 'Customer was billed twice for the same subscription renewal.' },
  { id: 'turn-2', text: 'Customer requested a refund for the duplicate charge of $49.99.' },
])

// On each new turn, query both: the FAQ index for knowledge, the session for what was said.
const userQuestion = 'how long does a refund take'
const [knowledge, recall] = await Promise.all([
  client.query('product-faqs', userQuestion, { topK: 3 }),
  session.query(userQuestion, { topK: 3 }),
])

// At the end of the call, persist the session for future retrieval.
await session.pushIndex()
```

## Loading a cloud index into a session

A session can also pull an existing cloud index into its local store with
[`loadIndex()`](./classes/SessionIndex#loadindex). With `autoRefresh: true` the SDK polls the
cloud and pulls newer versions in on subsequent reads (paused while the session has un-pushed
local edits).

```typescript theme={null}
const session = await client.session('call-123')
const loaded = await session.loadIndex('product-faqs', { autoRefresh: true })
console.log(`${loaded} docs loaded into the session`)
```

## Behavior notes

* Every session operation (`addDocs`, `deleteDocs`, `getDocs`, `query`) runs in process memory
  with no per-operation cloud round trip.
* The embedding model is set by the optional second argument to `session()` (default
  `"moss-minilm"`; also `"moss-mediumlm"` or `"custom"`). When resuming an existing cloud
  index, omit the model to adopt the stored one - all participants resuming the same index
  must use the same model.
* With `modelId: 'custom'`, each added document must carry an `embedding` and every `query`
  must pass an `embedding`. See [Custom embeddings](./custom-embeddings).
* `pushIndex()` uploads documents with their locally-computed embeddings; no server-side
  re-embedding occurs.

## Related

* [SessionIndex reference](./classes/SessionIndex) - every session method.
* [MossClient.session()](./classes/MossClient#session) - open or resume a session.
* [Metadata filtering](./metadata-filtering) - filter inside a session query.
* [SDK reference](./api) - the full JavaScript SDK overview.


> ## Documentation Index
> Fetch the complete documentation index at: https://docs.moss.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# Hybrid search

> Blend semantic and keyword scoring in JavaScript with a single alpha parameter.

Semantic (vector) search captures meaning; keyword (BM25) search captures exact terms.
Hybrid search blends both with one parameter, `alpha`, so you can tune relevance per query.
As with all queries, load the index first (or open a [session](./sessions)).

## The `alpha` parameter

`alpha` lives on [`QueryOptions`](./interfaces/QueryOptions).

| `alpha` | Behavior                                           |
| ------- | -------------------------------------------------- |
| `1.0`   | Pure semantic (embeddings only)                    |
| `0.0`   | Pure keyword (BM25 only)                           |
| between | Blends the two; default is semantic-heavy at `0.8` |

## Example

```typescript theme={null}
import { MossClient } from '@moss-js/moss'

const client = new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!)

await client.loadIndex('faqs') // required before querying

// Blend semantic and keyword scoring (60/40).
const hybrid = await client.query('faqs', 'return policy', { topK: 3, alpha: 0.6 })

// Pure keyword.
const keywordOnly = await client.query('faqs', 'return policy', { topK: 3, alpha: 0.0 })

// Pure semantic (the default leans here at 0.8).
const semanticOnly = await client.query('faqs', 'return policy', { topK: 3, alpha: 1.0 })

hybrid.docs.forEach(d => console.log(d.id, d.score, d.text))
```

The same `alpha` applies inside a [session](./sessions):

```typescript theme={null}
const session = await client.session('call-123')
await session.addDocs([{ id: 'turn-1', text: 'Customer asked about the SKU-4421 refund.' }])

// Lean on keyword scoring to match the exact SKU.
const hits = await session.query('SKU-4421', { topK: 3, alpha: 0.2 })
```

## Choosing alpha

* Lower `alpha` (toward keyword) when queries contain exact identifiers, SKUs, names, or jargon.
* Higher `alpha` (toward semantic) when queries are natural-language paraphrases.
* Tune per index and per intent (returns, billing, onboarding, and so on).

## Related

* [Metadata filtering](./metadata-filtering) - constrain results by document metadata.
* [Custom embeddings](./custom-embeddings) - bring your own vectors.
* [QueryOptions](./interfaces/QueryOptions) - all query parameters.
* [SDK reference](./api) - the full JavaScript SDK overview.

> ## Documentation Index
> Fetch the complete documentation index at: https://docs.moss.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# Metadata filtering

> Narrow JavaScript query results to documents whose metadata matches a filter.

Attach metadata to documents at index time, then constrain queries to the documents whose
metadata matches a filter. Filtering is evaluated on the locally loaded index, so call
[`loadIndex()`](./classes/MossClient#loadindex) (or open a [session](./sessions)) before
querying with a filter. The filter is passed as
[`QueryOptions.filter`](./interfaces/QueryOptions).

## Operators

A single condition compares one metadata field with a
[`FilterCondition`](./type-aliases/FilterCondition) operator.

| Operator                     | Meaning                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `$eq`, `$ne`                 | equals / not equals                                              |
| `$gt`, `$gte`, `$lt`, `$lte` | greater / less than                                              |
| `$in`, `$nin`                | value in / not in a list                                         |
| `$near`                      | within a haversine distance of a point: `"lat,lng,radiusMeters"` |

Compose multiple conditions with `$and` / `$or` (nestable). A single condition can be passed
on its own without a wrapper. See [`MetadataFilter`](./type-aliases/MetadataFilter) for the
full filter shape.

## Examples

```typescript theme={null}
import { MossClient } from '@moss-js/moss'

const client = new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!)

await client.createIndex('catalog', [
  { id: 'doc1', text: 'Running shoes with breathable mesh for daily training.',
    metadata: { category: 'shoes', price: '79', city: 'new-york', location: '40.7580,-73.9855' } },
  { id: 'doc2', text: 'Trail running shoes built for rocky terrain.',
    metadata: { category: 'shoes', price: '149', city: 'seattle', location: '47.6062,-122.3321' } },
  { id: 'doc3', text: 'Lightweight city backpack with laptop compartment.',
    metadata: { category: 'bags', price: '95', city: 'new-york', location: '40.7505,-73.9934' } },
])

await client.loadIndex('catalog') // required before filtering

// $eq - a single condition needs no wrapper.
await client.query('catalog', 'running gear', {
  topK: 5,
  filter: { field: 'category', condition: { $eq: 'shoes' } },
})

// $and - shoes under $100.
await client.query('catalog', 'running shoes', {
  topK: 5,
  alpha: 0.6,
  filter: {
    $and: [
      { field: 'category', condition: { $eq: 'shoes' } },
      { field: 'price',    condition: { $lt: 100 } },
    ],
  },
})

// $or - refund or upgrade topics.
await client.query('catalog', 'city essentials', {
  topK: 5,
  filter: {
    $or: [
      { field: 'city', condition: { $eq: 'new-york' } },
      { field: 'city', condition: { $eq: 'seattle' } },
    ],
  },
})

// $in - city in a set.
await client.query('catalog', 'city essentials', {
  topK: 5,
  filter: { field: 'city', condition: { $in: ['new-york', 'seattle'] } },
})

// $near - within 5km of Times Square.
await client.query('catalog', 'city products', {
  topK: 5,
  filter: { field: 'location', condition: { $near: '40.7580,-73.9855,5000' } },
})
```

## Filtering inside a session

The same filter syntax works on a [session](./sessions) query, evaluated entirely in-memory.

```typescript theme={null}
const session = await client.session('call-123')
await session.addDocs([
  { id: 't1', text: 'Customer opened the call about an incorrect charge.',
    metadata: { speaker: 'agent', topic: 'billing', priority: '3' } },
  { id: 't2', text: 'I need a full refund for the duplicate charge.',
    metadata: { speaker: 'customer', topic: 'refund', priority: '5' } },
])

// Customer turns about refunds only.
await session.query('what did the customer want', {
  topK: 5,
  filter: {
    $and: [
      { field: 'speaker', condition: { $eq: 'customer' } },
      { field: 'topic',   condition: { $eq: 'refund' } },
    ],
  },
})
```

## Related

* [Hybrid search](./hybrid-search) - blend semantic and keyword scoring.
* [Sessions](./sessions) - filter inside a live session.
* [MetadataFilter](./type-aliases/MetadataFilter) and [FilterCondition](./type-aliases/FilterCondition) - filter types.
* [SDK reference](./api) - the full JavaScript SDK overview.

> ## Documentation Index
> Fetch the complete documentation index at: https://docs.moss.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# Custom embeddings

> Bring your own vectors in JavaScript instead of a built-in on-device model.

Moss embeds text on-device with built-in models (`moss-minilm`, `moss-mediumlm`). If you
already generate embeddings elsewhere - a proprietary model, a hosted embedding API, or a
shared pipeline across services - use `modelId: 'custom'` to supply your own vectors. Moss
indexes and searches them; it does not load a local model.

## How it works

* At index time, every document must carry its own `embedding`. With `modelId: 'custom'`, Moss
  does not embed for you. (If you omit `modelId` and every document has an `embedding`, Moss
  infers `'custom'` automatically; mixed documents are rejected.)
* At query time, you must pass the query vector via
  [`QueryOptions.embedding`](./interfaces/QueryOptions), because there is no local model to
  embed the query text.
* All vectors must share the same dimensionality.

## Example

```typescript theme={null}
import { MossClient } from '@moss-js/moss'

const client = new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!)

// Your embedding function - any model, as long as dimensions are consistent.
async function embed(text: string): Promise<number[]> {
  // ...call your model or embedding API and return the vector
}

// Index with precomputed vectors. modelId: 'custom' -> Moss does not embed.
await client.createIndex('tickets', [
  { id: '1', text: 'Customer asked about billing', embedding: await embed('Customer asked about billing') },
  { id: '2', text: 'Refund requested for duplicate charge', embedding: await embed('Refund requested for duplicate charge') },
], { modelId: 'custom' })

await client.loadIndex('tickets') // required before querying

// Query with your own query vector (required for custom embeddings).
const queryVector = await embed('billing problem')
const results = await client.query('tickets', 'billing problem', { topK: 3, embedding: queryVector })
results.docs.forEach(d => console.log(d.id, d.score, d.text))
```

## In a session

Sessions support custom embeddings too: open the session with `modelId: 'custom'`, set
`embedding` on every document you add, and pass `embedding` on every query.

```typescript theme={null}
const session = await client.session('conv-123', 'custom')

await session.addDocs([
  { id: '1', text: 'Customer asked about billing', embedding: await embed('Customer asked about billing') },
])

const hits = await session.query('billing problem', { topK: 3, embedding: await embed('billing problem') })
```

<Note>
  With `modelId: 'custom'`, adding a document without an `embedding`, or querying without
  `embedding` in the query options, throws.
</Note>

## Related

* [Sessions](./sessions) - custom embeddings in a live session.
* [Hybrid search](./hybrid-search) - blend semantic and keyword scoring.
* [DocumentInfo](./interfaces/DocumentInfo) and [QueryOptions](./interfaces/QueryOptions) - where `embedding` lives.
* [SDK reference](./api) - the full JavaScript SDK overview.

> ## Documentation Index
> Fetch the complete documentation index at: https://docs.moss.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# Custom Authenticator (JS)

> Authenticate browser/frontend clients without shipping your projectKey.

By default, `MossClient` authenticates using your `projectId` and `projectKey`:

```ts theme={null}
import { MossClient } from '@moss-js/moss';

const client = new MossClient('your-project-id', 'your-project-key');
```

This works well for **server-side** code where secrets stay on the backend. For **browser / frontend** use, you should never embed your `projectKey` in client-side code. Instead, implement a custom `IAuthenticator` that fetches a short-lived token from your own backend.

## The `IAuthenticator` interface

The SDK exports `IAuthenticator` and `AuthToken` types from `@moss-js/moss`. Their
shapes are shown below for reference - you don't need to redefine them in your code.

```ts theme={null}
// Exported from '@moss-js/moss' - shown here for reference
interface AuthToken {
  token: string;      // Bearer token to send with each request
  expiresIn: number;  // Token lifetime in seconds, as returned by your backend
}

interface IAuthenticator {
  getAuthToken(): Promise<AuthToken>;
  getAuthHeader(): Promise<string>; // returns "Bearer <token>"
}
```

Both methods must be implemented. The SDK calls `getAuthHeader()` before every request.

## Recommended setup

### 1. Your backend - expose a token endpoint

Your backend holds the `projectKey` securely and uses the SDK to fetch a token, returning it directly to the frontend.

```ts theme={null}
// Example: Express route on your backend
import express from 'express';
import { MossClient } from '@moss-js/moss';

const app = express();
const moss = new MossClient('your-project-id', 'your-project-key');

// Protect this route with your own auth middleware
app.get('/api/moss-token', yourAuthMiddleware, async (req, res) => {
  try {
    // getAuthToken() returns { token, expiresIn } - forward it directly
    res.json(await moss.getAuthToken());
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve token' });
  }
});
```

### 2. Your frontend - implement `IAuthenticator`

Since your backend forwards the Moss auth response unchanged, `response.json()` already matches the `AuthToken` shape - no manual mapping needed.

```ts theme={null}
import { MossClient } from '@moss-js/moss';
import type { IAuthenticator, AuthToken } from '@moss-js/moss';

class MyBackendAuthenticator implements IAuthenticator {
  async getAuthToken(): Promise<AuthToken> {
    const response = await fetch('/api/moss-token', {
      credentials: 'include', // include your session cookie / auth header
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Moss token: HTTP ${response.status}`);
    }

    return response.json(); // shape matches AuthToken: { token, expiresIn }
  }

  async getAuthHeader(): Promise<string> {
    const { token } = await this.getAuthToken();
    return `Bearer ${token}`;
  }
}

// Pass your authenticator to MossClient
const client = new MossClient('your-project-id', new MyBackendAuthenticator());
```

## Token caching

The SDK automatically wraps your authenticator with an internal caching layer. Tokens are cached for `expiresIn - 60` seconds, so your backend is only called when the token is about to expire - not on every SDK request. No extra setup is needed.

<Tip>Make sure your backend returns the correct `expiresIn` value so the cache TTL is accurate.</Tip>

## Summary

| Use case               | How to initialize                                         |
| ---------------------- | --------------------------------------------------------- |
| Server-side (Node.js)  | `new MossClient(projectId, projectKey)`                   |
| Frontend - custom auth | `new MossClient(projectId, new MyBackendAuthenticator())` |

**Rule of thumb:** your `projectKey` must never appear in browser-facing code. The custom authenticator pattern ensures it stays on your server while the frontend still gets authenticated access to Moss.

