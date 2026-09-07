# Herdr + Pi coordinator

Declared version: **7.21-draft**. Identity is filename + declared version.

These two files are the only coordinator workflow policy. User authorization and project constraints still apply. Do not load historical drafts.

| File | Owns |
|---|---|
| `coordinator.md` | tasks, writers, lanes, QA/review, routing rules, handoff, plans, integration, publication boundaries |
| `routing_table.json` | routes, aliases, bindings, harness mappings, effort profiles, child-session permission defaults, triggers |

The operating card covers the [QA/review lifecycle](coordinator.md#3-qa-and-review), task scope, writer handoff, evidence/progress records, plan acceptance, routing/alias resolution, integration, and publication boundaries. Version 7.21 adds [continued waiting and result reconciliation](coordinator.md#6-evidence-progress-and-handoff) after dispatch. File-first handoffs remain in force; the reverted PR-review-loop policy remains absent; see [Routing](coordinator.md#4-routing) and `routing_table.json`. The operating card is self-contained; historical drafts are not policy dependencies. It does not provide event replay, epoch fencing, or automatic crash recovery.

## How to use

1. Clone this repository, or put the two files in one folder.
2. Open Pi in a Herdr coordinator Tab (keep that Tab for the coordinator only).
3. Read the two files, then paste:

```text
Read coordinator.md and routing_table.json as the coordinator workflow policy,
within the user's authorization and project constraints.
Declared version: 7.21-draft. Do not load archive/. Follow the card.
```

## Optional local components

The repository also versions these supporting components; they are not additional coordinator policy files and cloning the repository does not activate them:

- `skills/contract-first/SKILL.md`: compact interface/delivery/authority/verification guidance. Reuse existing task agreements; specialized artifact controls apply only when relevant.
- `extensions/artifact-guard/index.ts`: the Pi-only self-consistency tripwire. It is not a sandbox and does not automatically protect workers using other harnesses. The extension imports Pi's `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` packages from its host environment.

For the existing local setup, the skill belongs at `~/.agents/skills/contract-first/SKILL.md` and the extension at `~/.pi/agent/extensions/artifact-guard/index.ts`. Back up any existing files before intentionally installing or updating them. Reload Pi only at a safe task boundary; already-running instances retain their loaded code. This repository does not change global permissions or create workspace guard markers automatically.

`contract_check.behavioral_checks` contains required QA command strings, not prose labels. Finalization requires them to be explicitly supplied in `qa_commands` and to succeed; it never executes that contract field implicitly. Required outputs are checked both before and after QA/regeneration. Old prose-only contracts must be re-established after reload. Guard PASS covers declared checks only; project QA/review remains the acceptance authority.

## Regression tests

On a POSIX host with Node.js 22.18 or newer:

```sh
node tests/artifact-guard.test.mjs
```

The test has no npm dependencies. It runs 31 checks plus four ablation variants against repository source using isolated temporary fixtures and a stubbed Pi registration API. It does not read the user's guard defaults, write installed components, or call a model. This verifies callback/file/command behavior, not live Pi loader integration, actual warning rendering, or model compliance. Test fixtures are removed on exit.
