# Experimental Rust MCP frontend

This is an optional loopback HTTP/1 frontend for a Node-versus-Rust MCP comparison.
It does not start from `server/index.mjs`, replace `/mcp`, modify settings or deploy itself.
It requires Rust/Cargo and Unix sockets (macOS or Linux). npm remains dependency-free.
Cargo dependencies and their resolved versions are in `experimental/rust-mcp/Cargo.lock`.

## Execution boundary

Rust owns HTTP parsing, request admission and deadlines, body collection, JSON decoding,
JSON-RPC envelope validation, method selection, initialize protocol negotiation,
notifications and ignored client responses, response envelopes and HTTP serialization.
It handles `initialize`, `ping`, `tools/list` and `tools/call`, with the existing endpoint's
stateless plain-JSON behavior. There is no session ID, SSE stream, HTTP/2 or server push.
Like Node, it accepts absent Accept/protocol-version headers; it has no protocol-header gate.

Rust requests a live catalog from Node for `tools/list`, filters it against the current
principal's scopes, and removes internal scope fields while preserving schemas, ordering,
annotations and module/plugin tools. It does not maintain a synthetic catalog or credential
cache. Other JSON-RPC methods produce `-32601` in Rust. Notifications, client response
messages, pings and parse errors still authenticate through Node, but never execute a tool.

The private IPC bridge reuses `apiBearerOf` and the **running hub's exact access store**.
Every IPC request calls `accessStore.verifyKey` again. Account disabling, key revocation
and scope changes therefore apply to the next request, without restarting either process.
Rust cannot submit a principal, account ID or scopes. Browser sessions, application tokens
and push-agent tokens never substitute for an API key.

Node owns the existing tool implementations, argument/business validation, permissions,
business/storage state, errors, human-readable tool-result JSON text and audit writes.
`callTool` must retain the existing scope check even though Rust hides inaccessible tools
from the catalog. Denied writes must reach that check and its audit path. Initialization
instructions and server identity also come from the same business factory and registry.

This is a transport/protocol rewrite with shared Node business execution, **not a full Rust
Home Hub or Rust ticket-store implementation**. Each request pays an additional JSON encode/decode round trip over a pooled Unix socket.
Connections carry one operation at a time, are bounded by HTTP admission, and are reused
for up to five idle seconds. Failures discard the connection without replaying the operation.
Catalog requests send a content revision: Node always resolves current scopes and hashes the
live registry; unchanged descriptors stay cached in Rust. A changed registry sends the full
catalog before Rust filters it. This cache never stores principals or authorization decisions. Report the combined Node-plus-Rust CPU/RSS and request latency as well
as separate process measurements; Node process memory is still necessary. There is no speedup
claim here. The independent benchmark must use the same live business state and credentials,
exact request corpus, warmups, concurrency, connection reuse and release binary.

## Shared implementation

`server/mcp.mjs` exports `createMcpBusiness(options)`. The existing `createMcp` wrapper
uses that factory and exposes it as `handle.business`; `createHandler` exposes the same
instance as `handler.mcpBusiness` for the isolated experiment. Nothing starts Rust on the
normal server path. There is one registry, one live access store and one set of business
handlers for both endpoints. No secondary credential store or storage implementation is used.

## Embedding and running

The exported embeddable API is `createRustMcpBridge` in `server/mcp-rust-bridge.mjs`:

```js
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMcpBusiness} from './server/mcp.mjs';
import {createRustMcpBridge} from './server/mcp-rust-bridge.mjs';

// In the isolated harness's hub-construction scope:
// mcpOptions has exactly the same ctx, registry tools, instructions and version as Node.
// accessStore is that hub's existing live store, never a second store instance.
const business = handler.mcpBusiness;
const directory = await mkdtemp(path.join(os.tmpdir(), 'rmcp-'));
const bridge = await createRustMcpBridge({
  socketPath:path.join(directory, 'bridge.sock'), accessStore, business
});
try {
  // Launch binary with ['--socket', bridge.socketPath, '--bind', '127.0.0.1:0'].
  // Read its first stdout line as JSON. origin is the actual ephemeral HTTP origin.
  // Send ordinary authenticated JSON-RPC POST requests to `${origin}/mcp`.
  // Stop the child with SIGTERM and await its exit before closing the bridge.
} finally {
  await bridge.close();
  await rm(directory, {recursive:true, force:true});
}
```

`createRustMcpBridge` resolves to `{socketPath, limits, close()}`. `close()` is idempotent,
destroys accepted sockets and removes its socket if it still owns that inode. The caller
owns directory cleanup and must await running business work separately if doing teardown
after a timed-out write. The bridge refuses existing socket paths rather than unlinking them.

Build and run from the repository root:

```sh
cargo build --locked --release --manifest-path experimental/rust-mcp/Cargo.toml
experimental/rust-mcp/target/release/home-hub-rust-mcp \
  --socket /absolute/private/directory/bridge.sock --bind 127.0.0.1:0
```

Only explicit loopback IP addresses are accepted by `--bind`, including `[::1]:0`.
The default is `127.0.0.1:0`. `--socket` must be absolute. No bearer key is placed in
the command line or environment. The first stdout line is a JSON readiness object:

```json
{"event":"listening","origin":"http://127.0.0.1:49152","limits":{"bodyBytes":65536,"headerBytes":16384,"headerCount":64,"connections":128,"arrivalMs":10000,"ipcMs":30000,"connectionMs":60000}}
```

The binary uses two Tokio worker threads. It exits on SIGINT or SIGTERM. It does not
start a Node server or bridge itself, contact providers, collect hosts or use production
credentials. Readiness means the HTTP listener is bound; a missing bridge yields HTTP 503.
POST requests with an Origin header are rejected unless its exact value was supplied with
`--allow-origin` (repeatable). Host must identify localhost or a loopback IP. No CORS is enabled.

## Limits and private IPC

| Resource | Bound |
| --- | --- |
| HTTP request body | 65,536 bytes, including streamed/chunked requests |
| HTTP header buffer | 16,384 bytes, Hyper HTTP/1 parser buffer bound |
| HTTP header count | 64 |
| Accepted TCP connections | 128, excess connections immediately closed |
| HTTP header arrival | 10 seconds |
| HTTP body arrival | 10 seconds after headers |
| Absolute TCP connection lifetime | 60 seconds, including keep-alive and response writes |
| IPC request / response | 128 KiB / 16 MiB |
| IPC sockets / active business executions | 128 each |
| IPC operation / idle interval | 30 seconds, including connect/read/write |
| Unix directory / socket | owner-only 0700 directory / 0600 socket |
| Unix socket path | absolute; at most 100 UTF-8 bytes on Node side |

Node's bridge `limits` option can lower `requestBytes`, `responseBytes`, `connections` and
`timeoutMs`; it cannot raise defaults or add unrecognized limits. Both accepted sockets
and still-running executions are counted, so disconnecting slow work cannot create an
unbounded background execution queue. A private directory must already be 0700 and owned
by the current UID, or the bridge creates its final directory with mode 0700. It refuses
symlinked final directories and existing socket paths. Parent directories are trusted.
The socket protects access by other users; same-user processes are inside this trust boundary.

Wire format: one 4-byte unsigned big-endian length followed by one UTF-8 JSON payload
in each direction. Requests with `persistent:true` keep the connection for the next sequential
operation; omitted/false retains one-shot compatibility. No pipelining or multiplexing is used.
The bridge deadline covers each operation and idle interval. A `list` request can include
`catalogRevision`; the result always includes current scopes and revision, and omits `tools`
only when the revision matches. The Rust cache keeps a snapshot for each in-flight request
so concurrent registry updates cannot mix a revision with the wrong descriptors.
Input fields are strictly allowlisted; `v` must be 1:

```json
{"v":1,"operation":"authenticate","authorization":"Bearer <temporary-test-key>"}
{"v":1,"operation":"initialize","authorization":"Bearer <temporary-test-key>"}
{"v":1,"operation":"list","authorization":"Bearer <temporary-test-key>"}
{"v":1,"operation":"lookup","authorization":"Bearer <temporary-test-key>","name":"ticket_get"}
{"v":1,"operation":"call","authorization":"Bearer <temporary-test-key>","name":"ticket_get","arguments":{"id":"APP-1"}}
```

Replies are `{ok:true}`, `{ok:true,result:...}`, `{ok:false,status:401}` or
`{ok:false,error:{code,message}}`. `list` returns `{scopes,tools}`; `initialize` returns
`{serverInfo,instructions}`. `lookup` returns `{known}` only for malformed call arguments,
so Rust can retain Node's unknown-tool-before-invalid-arguments error precedence without
executing a tool. Ordinary exceptions become `-32603 / Internal error`;
integer-coded business errors preserve their code/message. Tool `isError` results pass
through unchanged. A frame limit violation closes the connection; oversized business
responses become a safe error after serialization. If even the error cannot fit a lowered
response cap, the bridge closes the socket. A late/disconnected write is never
automatically retried. As with any lost tool response, inspect state before retrying.
Neither process logs request bodies, tokens or tool exception text.

## Compatibility and comparison caveats

The old endpoint's envelope choices are intentional: batches get HTTP 400, malformed JSON
gets `-32700`, invalid envelopes get `-32600`, missing/null IDs are notifications (202),
client responses are ignored (202), and unknown methods get HTTP 200 with `-32601`.
Envelope IDs remain permissive to match Node. Unknown protocol versions choose the latest
supported version. Existing tool business validation, tool errors and structured content
must be compared through the parent's factory, not inferred from the transport unit tests.

Bounded hardening creates some differences: loopback Host checks, smaller header limits,
an absolute connection lifetime, a 16 MiB IPC response cap and serde_json's nesting limit.
HTTP header and body arrival have separate ten-second budgets, versus Node's single
request-arrival timer. Authentication occurs after body collection in Rust on the normal
path, so revocation during upload is observed before execution. Body/content-type refusals
authenticate before replying, retaining the usual auth-error precedence. Failed HTTP framing
can be rejected by Hyper before application auth, as Node's HTTP parser can also do.

Rust retains JSON integer precision rather than coercing all numbers to JavaScript doubles,
rejects escaped lone surrogates, and serialization/key order/escaping can differ. Compare parsed JSON recursively while also
checking exact tool text content. Restrict the fair corpus to valid JSON numbers and IDs
that survive Node parsing. Message truncation uses Rust Unicode scalar counts rather than
JavaScript UTF-16 units. These are explicit objections to claiming arbitrary-byte
equivalence; they do not change the shared ticket execution or state.

The parent must confirm full core/module/plugin catalog equality, successful and denied
writes plus audit equality, stale revisions, scope narrowing and account/key revocation
against the same hub. No real provider calls or production access are needed. A benchmark
that compares only ping, uses hardcoded authentication, omits the Node process overhead or
calls the Node `/mcp` endpoint through a Rust HTTP proxy does not measure this boundary.

## Checks

```sh
cargo test --locked --manifest-path experimental/rust-mcp/Cargo.toml
cargo build --locked --manifest-path experimental/rust-mcp/Cargo.toml
node --test experimental/rust-mcp/tests/bridge.test.mjs experimental/rust-mcp/tests/http.test.mjs
npm test
python3 tests/router_unifi_test.py
```

For HTTP tests against a release binary, set `RUST_MCP_BINARY` to its absolute path.
The Node bridge/HTTP tests use a real temporary access store and explicitly injected test
business handlers. They verify live disable/revoke/scope changes, framing, size caps,
permissions, protocol behavior and the actual Rust HTTP listener. They do **not** stand in
for the parent's independent full-tool shared-business tests or the 800-ticket benchmark.

## Independent parent validation and comparison

Build the release binary, then run the boundary and real-business tests:

```sh
cargo test --locked --manifest-path experimental/rust-mcp/Cargo.toml
cargo build --locked --release --manifest-path experimental/rust-mcp/Cargo.toml
RUST_MCP_BINARY=experimental/rust-mcp/target/release/home-hub-rust-mcp npm test -- experimental/rust-mcp/tests/bridge.test.mjs experimental/rust-mcp/tests/http.test.mjs experimental/rust-mcp/tests/equivalence.test.mjs
node scripts/compare-mcp.mjs --out /tmp/mcp-comparison.json
```

The comparison creates two isolated 800-ticket/1,600-attachment stores and temporary keys.
It accepts no production URL or key. `--corpus /absolute/synthetic/corpus` reuses a prior
benchmark manifest/corpus generator; omit it to generate disposable deterministic records.
The client driver and the two server workers are separate processes. Three rounds alternate
which endpoint is measured first; each operation has ten warmups and 100 measured calls.
The release Rust binary shares business execution with its own Node worker. Record combined
CPU and RSS, including that Node worker; RSS is an observation after each batch, not a peak.
macOS/Linux `ps` CPU sampling is coarse and adds sampling overhead. Mixed read tests exercise
8 and 32 clients. Provider traffic is disabled. Writes and background indexing are included;
write histories and created-ticket counts grow equally on both sides. Project creation uses one bounded 30-sample batch (plus warmups) to respect the 50-project quota.
Deduplicated upload is labelled explicitly; a separate create-and-attach measurement includes two
MCP calls, a new ticket and unique small file bytes.
