Moss JavaScript SDK
Source for the @moss-dev/moss JavaScript package.

Architecture
                    ┌──────────────────────────────────┐
                    │      Your application code       │
                    └──────────────┬───────────────────┘
                                   │
                    ┌──────────────▼───────────────────┐
                    │  @moss-dev/moss  (TypeScript)     │  ← sdk/
                    │  MossClient — async API for      │
                    │  indexing, querying, management   │
                    └──────────────┬───────────────────┘
                                   │
                    ┌──────────────▼───────────────────┐
                    │  @moss-dev/moss-core  (Rust/NAPI) │  ← bindings/
                    │  Index, IndexManager,             │
                    │  ManageClient, data models        │
                    └──────────────────────────────────┘
Directory	Package	Description
sdk/	@moss-dev/moss	TypeScript SDK. Fully open-source — install, build, modify, contribute.
bindings/	@moss-dev/moss-core	Native Rust/NAPI-RS bindings for the Moss engine. Source available for reference and debugging. Pre-built binaries on npm. Feature requests and bugs → open an issue.
Quick start
npm install @moss-dev/moss
import { MossClient } from "@moss-dev/moss";

const client = new MossClient("your_project_id", "your_project_key");

await client.createIndex("support-docs", [
    { id: "1", text: "Refunds are processed within 3-5 business days." },
    { id: "2", text: "You can track your order on the dashboard." },
]);

await client.loadIndex("support-docs");
const results = await client.query("support-docs", "how long do refunds take?", { topK: 3 });

for (const doc of results.docs) {
    console.log(`[${doc.score.toFixed(3)}] ${doc.text}`);
}
See sdk/README.md for the full API reference.

Contributing
SDK (sdk/) — open for contributions:

cd sdk
npm install
npm test
Bindings (bindings/) — source is published for reference. To request changes or report bugs, open an issue.

License
BSD 2-Clause License