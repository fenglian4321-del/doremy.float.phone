# Read-only derived Latent retrieval adapter

Upstream: https://github.com/oliscatt/Latent-memory
License: GNU AGPL version 3, retained in LICENSE. Inspected 2026-11-08.

Upstream Git blobs:
- src/memory_retrieval.py: c5b016c2ed2da456478a67b37a999c1bba8123eb
- src/chunking_experiment.py: 54bca9585536524ac309f0e7c1608e347be5bffa
- src/time_context.py: 382c37c014bbe17d9d71ac6a8a0ada0554b81b3e
- src/embedding_provider.py: cc5edb9be2aacb9489e0eccfdc5dc299464b1574

Only relative import scopes and attribution headers changed in these vendored files. Float uses add(), build() and retrieve_candidates() on current canonical Ombre entries, in memory only. The default lexical-graph-v1 mode uses MemoryIndex(embed=False) and does not call an embedding model. Explicit semantic-hybrid-v1 uses MemoryIndex(embed=True, provider=ConfiguredEmbeddingProvider(...)) with Float's separately implemented bounded, non-redirecting HTTP adapter; this is the upstream vector + lexical + graph route. Both modes preserve the original candidate-only ranking and never update the vendor's activation ledgers. No corpus, vector files, native MCP server or second writable fact store are created.

The canonical-pool fingerprint gates every search; native coordinated writes invalidate before mutation. Semantic construction and query IO occur outside the canonical writer lock. Publication and final return recheck the entire current pool, provider identity and generation, then inject only current canonical views. Pending builds, invalid vectors, provider failures, capacity overflow and stale results fail explicitly. Model-specific relevance calibration is required for standalone semantic candidates; no foreign model floor is assumed. This integration has been tested with synthetic vectors and HTTP fixtures only, not private provider APIs or real-world retrieval quality.

