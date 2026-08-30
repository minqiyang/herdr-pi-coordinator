# Herdr + Pi coordinator

Declared version: **6.2-draft**. Identity is filename + declared version.

| File | Owns |
|---|---|
| `coordinator_standard.md` | protocol, authority, state, gates, recovery |
| `herdr_pi_runtime.md` | Herdr/Pi process, lock/CAS, GitHub publication |
| `routing_table.json` | routes, models, triggers |

## 使用方法

1. Clone 本仓库，或让 coordinator 能读到这三份文件。
2. 把下面整段复制给 Pi coordinator（新项目和既有项目都用这一段）。

```text
Read these three files. They are the only policy. Declared version: 6.2-draft.

coordinator_standard.md
herdr_pi_runtime.md
routing_table.json

Do not take gate rules from any other skill. Do not rewrite routing.

Then:
- No project-binding event → PROJECT_INITIALIZED, then the smallest authorized card.
- Binding exists but not 6.2-draft → recover event head and epoch, PROJECT_RECONFIGURED, do not rewrite in-flight attempts, then the next authorized transition.
- Already bound to 6.2-draft → recover, then COORD-02. HOLD per ADV-01 if the next step is not authorized.
```

本机这份副本的路径（若 coordinator 读的是 Documents 里的目录，把上面三个文件名换成）：

```text
/Users/rhapsoul/Documents/Codex/standards/herdr_pi_coordinator_v6_three_file/coordinator_standard.md
/Users/rhapsoul/Documents/Codex/standards/herdr_pi_coordinator_v6_three_file/herdr_pi_runtime.md
/Users/rhapsoul/Documents/Codex/standards/herdr_pi_coordinator_v6_three_file/routing_table.json
```

仓库：https://github.com/minqiyang/herdr-pi-coordinator
