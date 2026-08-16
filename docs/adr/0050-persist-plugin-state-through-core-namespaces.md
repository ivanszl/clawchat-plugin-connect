---
status: accepted
---

# Persist Plugin state through Core namespaces

Core provides an optional declared Plugin Durable State Host Capability: transactional versioned JSON isolated by Plugin identity, capability identity, capability-instance identity, and one fixed lifetime scope of installation, Installation Owner, or Agent Binding, with no SQL, database schema, filesystem path, self-authored scope key, or cross-namespace access. Core preserves installation-scoped state across Owner Reset, deletes owner- and Binding-scoped state only after their external resources retire, and deletes every namespace after successful Plugin removal. An update migrates a staged copy and commits the active Bundle version and migrated state together only after precommit import and registration succeed; failure leaves the old Bundle and original state active. Exact managed-resource identities transfer to the selected version. Successful disable retires managed resources and disposes code but preserves configuration and state for re-enable; successful removal performs the same cleanup before deleting the Bundle, configuration, and every namespace.

ADR-0052 later supersedes the update commit point in this decision: Core now commits the selected version, configuration, migrated state, and Activation Generation after side-effect-free preparation but before post-commit start, and does not claim transactional rollback of external effects.

Core-hardcoded Liveware records were rejected because they would couple generic lifecycle recovery to one official integration and split Plugin-owned resource state across two persistence models. Plugin-owned files or databases were rejected because they bypass lifecycle fencing, owner cleanup, isolation, and common recovery semantics.
