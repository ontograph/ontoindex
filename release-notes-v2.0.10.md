# OntoIndex v2.0.10

## Highlights

- **Global Install Repaired**: `npm install -g ontoindex` no longer installs the local Hugging Face/ONNX runtime by default, avoiding large `onnxruntime-node` downloads that can fail with `ENOSPC`.
- **Optional Local Embeddings**: local embeddings and CE reranking now load Hugging Face dependencies only when those runtimes are explicitly initialized.
- **Clear Runtime Guidance**: if local embeddings are requested without optional packages, OntoIndex reports the missing optional dependency path and points users to HTTP embedding configuration.
