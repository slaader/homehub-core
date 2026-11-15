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
