# Historical: limit one Binding per Runtime family

This early restriction is not part of the current model. Agent Bindings reference exact Runtime Plugin capabilities,
and multiple Bindings or capabilities may share the same advertised Runtime family without collision.

Superseded first by ADR-0034 and finally by the exact Plugin capability provider contract.
