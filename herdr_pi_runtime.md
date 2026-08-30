# Herdr + Pi Runtime v6.2-draft

**Status:** REFERENCE_RUNTIME_NOT_ACTIVE  
**Implements:** `coordinator_standard.md` runtime and publication interfaces  
**Routing authority:** `routing_table.json`  
**Supersedes, when selected:** `herdr_tab_first_layout_policy_v1.md`, `herdr_completed_task_pane_retention_policy_v1.md`

This file is the sole authority for Herdr/Pi process behavior, durable event operations, and the selected Git/GitHub publication adapter. It does not grant project authority and does not define route, model, effort, or unavailable-binding replacement policy.

---

## 1. Runtime binding

```text
orchestration_plane = Herdr
coordinator_harness = Pi
canonical_visibility = named Herdr Tab or pane + registered OS process identity
durable_state = private control root
publication_provider = Git + GitHub
lock_file = PRIVATE_CONTROL_ROOT/coordinator.lock
event_log = PRIVATE_CONTROL_ROOT/decision_log.jsonl
event_head = PRIVATE_CONTROL_ROOT/event_head.json
epoch_file = PRIVATE_CONTROL_ROOT/coordinator_epoch.json
```

`RT-01` This runtime implements core `INV-02`, `INV-03`, `EVENT-01..04`, `EPOCH-01..04`, and `VIS-01..04`. If its unique filename and declared version are not selected by the active project-binding event, it is reference material only.

`RT-02` Herdr is the sole canonical orchestration plane. Pi is the coordinator harness and default agent harness. Another harness may be used only when `routing_table.json` authorizes the binding and the runtime can preserve equivalent visible identity, process inspection, fencing, and recovery.

---

## 2. Session topology

`RT-03` Register every canonical session under core `VIS-01`. The Herdr location is the named Tab or pane ID (`w1:tN` / `w1:pN`).

Independent canonical responsibilities MUST use a new named Tab. Keep the coordinator alone in its current Tab; do not split that Tab for independent child work. A pane MAY hold a tightly coupled child process of the same logical task only when simultaneous viewing is useful and both identities remain visible and registered. Tab separation is layout isolation, not filesystem or Git isolation. Do not move a running agent between Tabs while `agent wait` or `agent prompt --wait` is active.

`RT-04` Core `INV-03` applies.

---

## 3. Dispatch

`RT-05` Dispatch canonical sessions in auto mode. There is no bypass posture.

Before dispatch, the coordinator records only the resolved values required to operate the card:

```text
stage and blocker/transition
card and attempt
authority grant
lane, mode, and structural reasons
exclusive root and lease
route and active binding
effort rule
required gate
```

Route, effort, and unavailable-binding replacement logic is resolved by routing-table rule ID under core `ROUTE-06` and `ROUTE-07`. Selected prompt-constraint text is inserted verbatim from the table; it MUST NOT be manually re-authored into a competing prompt rule.

When routing returns `STOP_TASK`, apply core `ROUTE-06` and `STATE-03`. Dispatch nothing.

---

## 4. Reconcile Tabs

`RT-06` At every core-mandated reconciliation:

1. Enumerate Herdr Tabs, panes, foreground processes, and relevant child processes.
2. Compare them with the active coordinator epoch, session registry, events, cards, physical roots, and leases.
3. Identify hidden, duplicate, missing, stale, misrouted, or old-epoch canonical processes.
4. Return to a live original pane instead of resuming or duplicating it.
5. Hold canonical transition until topology drift is recorded and resolved.
6. Verify replacement topology before cleanup.

`RT-07` Core `VIS-03` applies with orchestration plane = Herdr.

---

## 5. Round and cleanup behavior

`RT-08` At round completion, freeze artifacts/evidence, commit the transition, and release or transfer leases. A Tab closes only when core `VIS-04` is proven.

Do not close a completed execution Tab or pane immediately. Keep writer, QA, fixer, reviewer, and integrator Tabs visible until the next coordination round is live, then close obsolete completed execution Tabs one by one. Do not close a Tab that is still `working` or `blocked` unless the owner explicitly asks. Stay open while the Tab is the only practical recovery path or while disk and live state disagree. The coordinator Tab remains open except during an accepted graceful rotation or emergency takeover.

---

## 6. Durable event operations

These procedures implement the exclusive lock, durable append, sync, compare-and-swap, and atomic-head-update that core `EVENT-02` and `EPOCH-03` assign to the runtime. They run only on the private control root.

`RT-09` Exclusive lock:

1. The lock object is `PRIVATE_CONTROL_ROOT/coordinator.lock`.
2. Acquire it with a POSIX exclusive `flock` (or equivalent OS exclusive lock) before any canonical event append, `event_head.json` mutation, `coordinator_epoch.json` mutation, or lease mutation.
3. After acquiring the lock, read `coordinator_epoch.json` and refuse the mutation unless this session is the active epoch.
4. The lock is not authority. Epoch and fencing token remain the authority; the lock only serializes writers.
5. Do not break a lock held by a live process. A dead holder's lock may be stolen only as part of core `EPOCH-03` takeover, after that proof is recorded.

`RT-10` Durable append and head CAS, all under `RT-09`:

1. Read `event_head.json`. Verify that `event_hash` equals the hash of the last valid line in `decision_log.jsonl` (empty log: head is the sequence-zero null predecessor).
2. If they disagree, stop. That disagreement is `RECOVERY_REQUIRED`; do not append.
3. Build the new event per core `EVENT-02`. Append one JSON line to `decision_log.jsonl`.
4. `fsync` the log file descriptor.
5. Write the new head to `event_head.json.tmp`, `fsync` that file, then atomic-rename it over `event_head.json`. `fsync` the control-root directory if the OS requires directory fsync for rename durability.
6. Materialize `current_state.json` the same temp + `fsync` + rename way.
7. Release the lock after reconciling `current_handoff.md` and leases, or after aborting into `RECOVERY_REQUIRED`.

If step 3 or 4 succeeded and step 5 failed, the extra log line is an unheaded orphan. It is not canonical. Leave it in place and enter `RECOVERY_REQUIRED`. A later authorized retry with the same idempotency key may commit the same semantic event; do not delete the orphan to hide the failure.

`RT-11` Epoch CAS, under `RT-09`:

1. Read `coordinator_epoch.json`.
2. Compare the expected epoch, fencing token, and event head with disk.
3. If any expected value differs, abort into `RECOVERY_REQUIRED`. Do not retry the same CAS as success.
4. Write epoch `N+1` with the new fencing token and predeclared acquisition event ID to `coordinator_epoch.json.tmp`, `fsync`, atomic-rename over `coordinator_epoch.json`.
5. Then commit the acquisition event through `RT-10` before any other canonical event or dispatch.

`RT-12` After crash, before any dispatch:

- last log line hash ≠ `event_head.json` → `RECOVERY_REQUIRED` (orphan or truncated log);
- `event_head.json` names a hash absent from the log → `RECOVERY_REQUIRED`;
- `current_state.json` disagrees with replay from the headed log → regenerate `current_state.json` from the log; never treat the stale view as history.

---

## 7. Coordinator rotation and takeover

### Graceful rotation

`RT-13` Graceful rotation implements core `EPOCH-02`:

1. The current coordinator stops new dispatch and records the proposed successor.
2. Start the successor in a new named Herdr Tab without granting write authority.
3. The successor independently replays the event log and inspects Tabs, process trees, roots, leases, blocker, and next transition.
4. Both coordinators compare the exact event head and record agreement or a HOLD.
5. Under `RT-09` and `RT-11`, activate epoch `N+1`, bind the successor session and fencing token, and revoke epoch `N`.
6. Commit the acquisition event through `RT-10` before the successor dispatches.
7. Close the former coordinator Tab only after its process is inactive and core `VIS-04` holds.

### Emergency takeover

`RT-14` Emergency takeover implements core `EPOCH-03..04` and does not wait for agreement from the failed coordinator:

1. Open a dedicated recovery Tab under a recovery card or standing recovery grant.
2. Inspect the prior coordinator Tab, OS process tree, child processes, last heartbeat, policy timeout, event head, leases, and post-head root changes.
3. Prove the prior coordinator is dead, unreachable beyond the declared limit, or already fenced. If proof is insufficient, HOLD.
4. Acquire `RT-09`. If the lock is held by a live process, abort.
5. Compare the expected epoch, fencing token, and event head with disk (`RT-11`). If any value changed, abort into `RECOVERY_REQUIRED`.
6. Otherwise activate epoch `N+1` with a new fencing token and predeclared acquisition event ID.
7. Durably commit the acquisition event through `RT-10` before any other canonical event or dispatch.
8. Keep ambiguous leases and writes HOLD or QUARANTINED until independently reconciled.
9. Stop or isolate any later-discovered old-epoch process; its output cannot become canonical merely because takeover succeeded.

A superseded epoch is permanently rejected for event append, lease mutation, acceptance, and publication.

---

## 8. Recovery behavior

`RT-15` Apply core `REC-01..02`. Persist substantive handoff facts in control artifacts, not Tab transcripts.

---

## 9. Git/GitHub publication adapter

This adapter is active only when the project binding selects this uniquely named runtime version and an authority grant permits the requested external effects.

Core `PUB-01..04` apply. This adapter supplies the GitHub workflow and the provider-specific bans below.

### Protected workflow

```text
accepted exact candidate
→ verify publication grant and holds
→ verify branch/base/head identities
→ push candidate branch
→ create or update PR
→ required CI on exact head
→ GitHub-hosted review/security checks on exact head
→ translate provider labels through project severity policy
→ resolve every blocking MATERIAL finding through a fresh attempt
→ rerun invalidated local and hosted evidence
→ verify protection, merge queue, and release-window assumptions
→ protected merge/merge queue
→ record PR, head, merge commit, checks, and timestamps
```

`PUB-GH-01` Provider-specific bans, in addition to core `PUB-03`:

- No direct push to the protected default branch.
- No force-push unless a separate explicit authority grant names the branch and recovery plan.
- No protection bypass or admin override without an explicit owner gate.
- No auto-merge unless standing publication authority explicitly permits it.
- A merge-eligible PR either progresses or enters a recorded HOLD with an unblock condition.

`PUB-GH-02` External P0/P1/P2 or similar labels do not redefine local policy. The active project binding references the severity mapping into `MATERIAL` or `ADVISORY` and any accepted-risk authority.

`PUB-GH-03` GitHub-hosted gates are independent of local acceptance. When a required hosted gate cannot run, HOLD unless an accepted rule names an equivalent mechanism satisfying the same identity and coverage requirements.

`PUB-GH-04` Core `PUB-04` applies before merge or deployment.

---

## 10. Bootstrap

```bash
cd <REPO_ROOT>
PI_FFF_MODE=tools-only PI_FFF_MULTIGREP=1 pi
```

Inside Pi:

```text
/name <namespace>-coord
/skill:herdr
```

Bootstrap prompt:

```text
You are <namespace>-coord, the sole active coordinator for epoch <epoch>.

Core standard: <unique core-standard filename + declared version>
Runtime: <unique runtime filename + declared version>
Routing table: <unique routing-table filename + declared version>
Project binding event: <event id + event hash>

Recover the event head and active epoch, then reconcile Herdr Tabs, process
trees, mutable roots, and leases. Validate authority before selecting the
smallest next card. Follow core COORD-02. Record an ADV-01 hold or owner
gate when the next transition is not authorized.
```

The prompt references authoritative rule IDs and uniquely named versions. It MUST NOT duplicate routing, review, or publication logic.
