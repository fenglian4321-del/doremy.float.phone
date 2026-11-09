# MemoryConstellations visualization adapted for Float

Original: https://github.com/ClaraShafiq/MemoryConstellations
Copyright (c) 2026 Clara Shafiq & Draco Malfoy. MIT; see LICENSE.
This is an unofficial modified integration, not the upstream application.

Inspected 2026-11-08; Git blob fingerprints:
- js/memory/state.js: 007e423f2c36c0d2bb57a40438d79c4013600946
- js/memory/layout.js: c51ffdd4602a907049ed054a3cd6c5aef98ca351
- js/memory/render.js: dd30dbcc98e2adbc87d8ff48199ba5d60bf0b11b
- js/memory/data.js: cf011f5da824ef57d7d062fe4859c1d11fada2c8
- js/memory/main.js: e88c4de2c85c2c016b5664faa6393a9e5ac76d5f

Reused state.js, layout.js, render.js (with attribution headers). data.js retains upstream color/hash/random helpers and replaces upstream API/auth/persistence with an in-memory Float presentation adapter. frame.js/frame.css/frame.html are Float glue. No native backend, pipeline, model, localStorage token or memory database is imported. The iframe accepts only the current loaded summaries, communicates with its parent of the same origin, and cannot send network API requests (CSP connect-src 'none'); its static scripts/styles load from the same origin. Factual reads and edits remain with Float's existing shared-memory proxy and canonical Ombre store.

Groups use original type and first existing tag/domain. All stars use equal brightness; no emotional/importance scores are inferred. Center stars are decorative. Lines are layout connections within a group, not asserted semantic relationships. Graph is capped at 200 summaries; journal preserves the existing loaded results. Parent journal and in-frame text picker provide keyboard access. Animation is paused offscreen/hidden and honors prefers-reduced-motion. Raw memory content is never inserted as HTML.

