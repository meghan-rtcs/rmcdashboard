---
name: SQLite snapshot-table writes
description: How to safely rebuild whole snapshot tables from a rate-limited upstream without data loss
---

# SQLite snapshot-table writes

Tables that are rebuilt wholesale on each sync (e.g. `ls_tasks`, `ls_processes`)
must follow two rules together, or a rate-limited/failed run destroys good data:

1. **Replace atomically.** `clearTable` + `upsertMany` are two separate
   transactions — a crash between them leaves the table empty. Use
   `replaceTable(table, rows, columns)` in `server/lib/db.js`, which does
   DELETE + inserts inside ONE `db.transaction`.

2. **Only replace when the upstream pull fully succeeded.** Use `null` as the
   failure sentinel from `safe(promise, null)` (vs `[]` for a genuine empty
   success). Rules:
   - Tasks: BOTH the upcoming AND completed pulls must succeed before swapping —
     otherwise a failed completed-pull (the one carrying `completed_at`)
     overwrites good rows with upcoming-only data.
   - Processes: ALL process types must succeed before swapping — the table is
     rebuilt wholesale, so a partial replace silently drops rows for the
     rate-limited types.
   - On any failure, keep the previous snapshot (log a warning + push to errors).

**Why:** LeadSimple's per-window record rate limit means partial pulls are normal,
not exceptional. Treating an empty/partial pull as "the truth" once wiped the
completed-task data and zeroed the KPIs.
