---
name: contract-first
description: Clarify interface ownership, deliverables, authority, and behavioral verification before implementation or artifact changes. Reuse existing task agreements; specialized artifact controls apply only when relevant. Not for read-only explanation or summarization.
---

# Contract First

Before changing implementation or artifacts, establish four things at the level the task needs:

- **Owner:** which existing file/module defines the interface or behavior? Keep one authoritative definition; consumers should reuse it.
- **Delivery:** what result and consumer expectations must remain true?
- **Authority:** what work is authorized, and where can it safely happen?
- **Verification:** which observable checks demonstrate success and catch relevant failures?

Reuse the task card, accepted plan, tests, and project rules when they already answer these questions. Ordinary edits need no separate contract document, fixed file bundle, read/write file allowlist, or universal edge-case checklist. Resolve material ambiguity before writing, not by inventing governance artifacts.

## When artifacts need exact identity or reproducibility

- Use exact byte identities for frozen inputs/candidates when required; paths and hashes identify evidence, never grant authority.
- Keep future evidence locatable through stable interfaces rather than requiring its future absolute path in a frozen input.
- Require manifests, disjoint required/forbidden outputs, self-exclusion of inventory hashes, and deterministic regeneration only where the deliverable actually needs them.
- Test executable behavior with execution evidence. Do not weaken requirements or modify a frozen candidate to manufacture a pass.

## When Artifact Guard is actually available

- It is a local Pi tripwire, not a sandbox or a cross-harness policy. Do not require unavailable tools in other harnesses; use their native controls and project QA/review.
- In ENFORCE mode, establish `contract_check` before mutation. If a contract is active, keep its roots and inputs current; resolve a blocked write rather than bypassing it. Inspect returned effective roots, which may include the session repository and configured defaults. Scratch exemptions depend on configuration and do not waive ENFORCE's initial contract gate.
- `behavioral_checks` lists required QA command strings, not prose labels. Supply those commands explicitly to `artifact_finalize`; it verifies outputs and runs the supplied checks. Use regeneration only when required by the artifact contract. After reload, an old prose-only list needs a new contract with actual commands.
- Finalize established contracts before claiming completion. Its PASS is limited to declared artifacts/checks; final acceptance still belongs to the project's QA/review process. Do not duplicate that process here.
