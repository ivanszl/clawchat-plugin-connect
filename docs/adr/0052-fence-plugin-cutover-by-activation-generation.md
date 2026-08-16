---
status: accepted
---

# Fence Plugin cutover by Activation Generation

Plugin replacement uses prepare, commit, then start rather than claiming a transaction over arbitrary external effects. Prepare imports and registers the candidate, validates configuration, and migrates a copied state without externally visible effects. Core atomically commits the selected Bundle version, configuration, migrated state, and next Activation Generation, disposes the old generation, and then starts the selected generation; it publishes capabilities only after every required start succeeds. Start failure stops contributions begun by that generation and leaves the selected Bundle visibly erroneous without automatic rollback. Every contribution, state mutation, browser graph, and managed-resource operation carries the generation fence, so a replaced generation cannot write after cutover. This sacrifices transparent rollback but gives one truthful commit point and avoids pretending remote systems participate in Core's transaction.
