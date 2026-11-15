# Optional ticket embeddings

Full-text search is the default, including attachment metadata and accepted UTF-8 contents. It works without a provider. To configure an optional embedding provider, set `HOME_HUB_TICKET_EMBEDDING_URL`
(the OpenAI-compatible embeddings endpoint) and `HOME_HUB_TICKET_EMBEDDING_MODEL` together. Then restart Home Hub and use Administration → Platform settings to enable semantic search.
A configured provider alone sends no text until this administrator opt-in is enabled. Full-text remains
the default after enabling; choose semantic or hybrid mode explicitly when useful. Disabling cancels
background work and queries; cached vectors remain on disk for later reuse.
Optional `HOME_HUB_TICKET_EMBEDDING_TOKEN` authenticates requests; never put it in tracked files.
`HOME_HUB_TICKET_EMBEDDING_REVISION` invalidates model caches after model changes;
`HOME_HUB_TICKET_EMBEDDING_QUERY_PREFIX` supplies the model's query instruction.
`HOME_HUB_TICKET_SEARCH_MIN_SCORE` sets the default cosine floor (0–1, default 0.5).
Use HTTPS, or explicit loopback HTTP for a local provider. Credentials in URLs and redirects
are refused. Provider failures report degraded coverage; writes never wait for a model.
The threshold is model-dependent and offers no universal accuracy guarantee.

Model backfill runs in the background. Provider request concurrency and its queue are bounded;
queued interactive queries precede queued backfill batches. Identical questions are coalesced.
A failed batch has bounded immediate retries, then a recovery cooldown; failed extraction also
settles as degraded and recovers. Search status reports file-content and vector coverage.
A query cosine floor is model-specific: calibrate it with representative positive and unrelated
questions before treating it as a production rejection boundary.

### Local Qwen embedding example

With llama.cpp installed and a Qwen3-Embedding-0.6B GGUF downloaded:

```sh
llama-server -m /path/to/Qwen3-Embedding-0.6B-Q8_0.gguf --embedding --pooling last --host 127.0.0.1 --port 8081 --alias ticket-embeddings
```

Set these in the Home Hub service environment, then restart it:

```sh
HOME_HUB_TICKET_EMBEDDING_URL=http://127.0.0.1:8081/v1/embeddings
HOME_HUB_TICKET_EMBEDDING_MODEL=ticket-embeddings
HOME_HUB_TICKET_EMBEDDING_REVISION=qwen3-0.6b-v1
HOME_HUB_TICKET_EMBEDDING_QUERY_PREFIX='Instruct: Given a question, retrieve relevant tickets and attachment passages.
Query: '
```

The query prefix contains a real newline. Qwen retrieval documents have no instruction prefix;
see the [official Qwen model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) and
[GGUF/server guide](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF). The platform page
shows the same example, whether or not a provider is configured. It does not install or start models.

[EmbeddingGemma](https://huggingface.co/google/embeddinggemma-300m) is another embedding model,
not a chat Gemma endpoint. Its server/adapter must apply the model's query and document formatting
and expose OpenAI-compatible embeddings; the Hub only adds QUERY_PREFIX to queries. Do not assume
Qwen's prompt or cosine threshold is appropriate for Gemma.


## Site configuration and deployment reference


Everything about your home lives in `local/`, which the hub reads at start and git ignores in a public checkout:

```sh
mkdir -p local && cp config/site.example.json local/site.json
```

Edit it and restart. Every field is optional, and a wrong one stops the server with a message that names it.
`local/` is the default during the 1.0 line, which deprecates it: an instance directory (`HOME_HUB_HOME`, its `config/site.json`;
[docs/storage.md](storage.md)) keeps configuration, data and secrets apart from the code instead.

| Field | What it sets |
|---|---|
| `siteName` | The name in the sidebar, the page title and the installable-app name |
| `lanCidrs` | Your networks, for example `["10.0.0.0/24"]` |
| `timeZone`, `defaultLanguage` | The zone every time is shown in; `en` or `cs` until a browser chooses |
| `publicOrigin` | The address browsers use, for example `https://hub.example.lan` |
| `devices[]` | The devices on the overview: name, address, role, picture, hardware, how collectors reach them |
| `inventory.places[]`, `inventory.secretStores[]` | Your vocabulary for the inventory map |
| `tracker.projects[]` | Projects a new tracker starts with |
| `router` | Which router adapter feeds the client census |
| `runtimes[]` | Local LLM runtimes the hub reads directly: `{device, kind, url, name?}` |
| `plugins.<id>` | Settings for a plugin |

[docs/plugins.md](plugins.md) describes every field. Pictures in `local/images/` are served under `/images/`.



Put the hub behind a reverse proxy that terminates TLS, and tell it the address browsers use:

```sh
ORIGIN=https://hub.example.lan HTTP_BEHIND_PROXY=1 PORT=8799 BIND_HOST=127.0.0.1 node server/index.mjs
```

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | Port to listen on | `8781` |
| `ORIGIN` | The origin browsers use; POSTs from anywhere else are refused | `publicOrigin` from `site.json`; with neither, the server does not start |
| `LOCAL_PREVIEW=1` | Plain HTTP on 127.0.0.1, for trying it out | off |
| `HTTP_BEHIND_PROXY=1` | Plain HTTP behind your TLS proxy | off: HTTPS with `TLS_KEY` / `TLS_CERT` |
| `BIND_HOST` | Address to bind | `0.0.0.0` (`127.0.0.1` in a preview) |
| `HOME_HUB_HOME` | An instance directory that keeps configuration, data and secrets apart from the code: `config/` (`site.json`, `software-watch.json`, `images/`), `data/` (with `data/state/`), `private/`. The variables below still win one by one | unset: everything is in the checkout, as in the rows below |
| `DATA_DIR`, `STATE_DIR`, `AUTH_FILE` | Collector output, the hub's own state, the administrator sign-in | `data/`, `data/state/`, `private/auth.json` (with `HOME_HUB_HOME`: `<home>/data`, `<home>/data/state`, `<home>/private/auth.json`) |
| `HOME_HUB_PRIVATE_DIR` | Where secrets live: `auth.json`, `secret.key`, tokens, backup keys, the TLS key | `private/` (`<home>/private`) |
| `HOME_HUB_CONFIG_DIR` | Where the household configuration lives: `site.json`, `software-watch.json`, `images/` | `local/` (`<home>/config`) |
| `HOME_HUB_SITE_CONFIG`, `HOME_HUB_PLUGINS_DIR` | Another site file, or plugin directories (several separated by `:`); `none` for neither | `<config>/site.json`; the plugin sources `HOME_HUB_HOME/instance.json` names, else `local/plugins/` |
| `HOME_HUB_UPDATE_CHECK=off` | Never ask whether a newer release exists (below) | on |

State is one SQLite database and a few JSON files ([docs/storage.md](storage.md) says where each one is). Back up
`data/` and `private/` (with `HOME_HUB_HOME`, the instance directory).
