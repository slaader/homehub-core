# Optional ticket embeddings

Text search including attachment contents works without a provider. To opt in to sending ticket
and accepted attachment text to an embedding provider, set `HOME_HUB_TICKET_EMBEDDING_URL`
(the OpenAI-compatible embeddings endpoint) and `HOME_HUB_TICKET_EMBEDDING_MODEL` together.
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
