# MCP review follow-ups 2.2.29 (2026-10-14)

Fixed: doctor no-target downgrade (doctor layer only, gnDiagnose contract unchanged); failed native open cool-down eviction in pool-adapter (driver close awaits a rejected _initPromise, so the completed rejected promise is cleared before close); response-pages small maxBytes floor; ensure-fresh embeddings `prerequisites`.

Verified in 2.2.28 live run: `ontoindex setup` in a temp HOME skips an existing user skill, writes `.ontoindex-managed` markers, and keeps a gitnexus dir that has extra files.

Still open: missed symbols `isManagedClone` and `cloneFresh` in the index at 7b1494c (cause unconfirmed); hand-edited `.retention-managed` marker ordering; embeddings need `analyze --embeddings`; `clean --generations --force`, release 2.2.24+, removal of `ONTOINDEX_MCP_REPO` from the ontocode configs await the user.
