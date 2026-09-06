# Herdr + Pi coordinator

Declared version: **7.14-draft**. Identity is filename + declared version.

These two files are the only coordinator workflow policy. User authorization and project constraints still apply. Do not load historical drafts.

| File | Owns |
|---|---|
| `coordinator.md` | tasks, writers, lanes, QA/review, routing rules, handoff, plans, integration, publication boundaries |
| `routing_table.json` | routes, aliases, bindings, harness mappings, effort profiles, child-session permission defaults, triggers |

The operating card covers the [QA/review lifecycle](coordinator.md#3-qa-and-review), task scope, writer handoff, evidence/progress records, plan acceptance, routing/alias resolution, integration, and publication boundaries. Version 7.14 stops repeated unresolved PR-review loops for independent whole-PR reassessment and a recorded coordinator disposition; see [Routing](coordinator.md#4-routing) and `routing_table.json`. The operating card is self-contained; historical drafts are not policy dependencies. It does not provide event replay, epoch fencing, or automatic crash recovery.

## How to use

1. Clone this repository, or put the two files in one folder.
2. Open Pi in a Herdr coordinator Tab (keep that Tab for the coordinator only).
3. Read the two files, then paste:

```text
Read coordinator.md and routing_table.json as the coordinator workflow policy,
within the user's authorization and project constraints.
Declared version: 7.14-draft. Do not load archive/. Follow the card.
```
