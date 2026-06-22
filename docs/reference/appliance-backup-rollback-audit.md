---
summary: "Appliance backup, plugin-write rollback, and audit logging pattern"
read_when:
  - Designing appliance operations for backup, rollback, or audit logging
  - Adding a plugin that writes to a file server or other operator-owned storage
  - Preparing disclosure text for what OpenClaw logs during approved writes
title: "Appliance Backup, Rollback, and Audit"
---

# Appliance Backup, Rollback, and Audit

This page defines the appliance operations pattern for deployments where OpenClaw
can perform approved writes to operator-owned storage. It covers three layers:
whole-appliance backup, plugin write rollback, and audit logging.

The repo-side implementation lives in
`scripts/appliance-backup-rollback-audit.mjs`. It is safe to run on a bench or
appliance host because it only writes to operator-supplied backup,
cold-storage, and audit paths.

## Whole-appliance backup

Use the first-class OpenClaw backup archive command as the appliance backup
primitive:

```bash
node scripts/appliance-backup-rollback-audit.mjs backup \
  --output /srv/openclaw/backups \
  --audit-log /var/log/openclaw-appliance/audit.jsonl \
  --retention-count 14 \
  --retention-days 90 \
  --json
```

The wrapper runs `openclaw backup create --verify --json`, then prunes old
archives. A backup is not considered successful unless archive verification
passes.

If the appliance config is damaged and workspace discovery blocks backup
creation, run the wrapper with `--no-include-workspace` for a partial config and
state backup while you repair the workspace configuration.

Recommended Phase 1 bench policy:

- Cadence: nightly verified archive, plus an operator-triggered archive before
  gateway upgrades, plugin installs, or policy changes.
- Retention: keep at least 14 verified archives and anything newer than 90 days.
- Storage: write the primary copy to local appliance storage outside OpenClaw
  state, then replicate that backup directory to cold storage controlled by the
  operator.
- Recovery test: at least monthly, restore the latest verified archive into a
  disposable bench host or temp home, then run `openclaw backup verify` against
  the archive used for the restore.

## Plugin write rollback

Every plugin that writes to the file server or other operator-owned storage must
archive originals before the live write. The archive step is deliberately
separate from the plugin-specific write logic so write plugins share one
rollback contract.

A plugin write flow should be:

1. Build a write-set manifest containing the plugin id, operation id, approval
   metadata, reason, and absolute target paths.
2. After human approval and before writing live data, create the cold-storage
   archive:

   ```bash
   node scripts/appliance-backup-rollback-audit.mjs archive \
     --manifest /srv/openclaw/write-sets/file-reorg-op-123.json \
     --cold-storage /srv/openclaw/cold-storage/plugin-originals \
     --audit-log /var/log/openclaw-appliance/audit.jsonl \
     --approved-by "operator@example.com" \
     --approval-id "approval-123" \
     --reason "approved file reorganization"
   ```

3. Perform the plugin write.
4. Keep the generated archive directory until the operation exits the rollback
   window.

Example write-set manifest:

```json
{
  "operationId": "file-reorg-2026-06-22-001",
  "plugin": "file-reorg",
  "approvedBy": "operator@example.com",
  "approvalId": "approval-123",
  "reason": "approved file reorganization",
  "files": [
    { "path": "/srv/files/working-copy/example.txt" }
  ]
}
```

Rollback restores the archived originals and removes targets that did not exist
before the write:

```bash
node scripts/appliance-backup-rollback-audit.mjs restore \
  --archive /srv/openclaw/cold-storage/plugin-originals/file-reorg/2026-06-22T10-00-00.000Z-file-reorg-2026-06-22-001 \
  --audit-log /var/log/openclaw-appliance/audit.jsonl \
  --approved-by "operator@example.com" \
  --approval-id "approval-rollback-123" \
  --reason "rollback approved after verification failed" \
  --json
```

## Audit logging

Appliance audit events are append-only JSONL records. The default bench location
is an operator-owned path such as `/var/log/openclaw-appliance/audit.jsonl`.
Restrict the parent directory to the appliance operator account or operations
group.

The audit log records:

- Tool-level backup completion, retention settings, and prune counts.
- Plugin write archive creation, plugin id, operation id, approval id, approver,
  reason, cold-storage archive path, target count, and how many originals
  existed.
- Rollback completion, plugin id, operation id, approval id, approver, reason,
  archive path, target count, and restore count.
- Rollback drill completion, archive path, synthetic working file path, hashes,
  and pass/fail state.

The audit log does not record file contents. It does record absolute paths and
hashes, so treat it as sensitive operational data. Do not ship audit logs to
third parties unless the operator has reviewed the disclosure and redaction
policy.

Recommended retention:

- Keep appliance audit JSONL locally for 1 year.
- Keep cold-storage write archives for at least the plugin write rollback window,
  with a 90-day minimum for Phase 1.
- Keep backup creation and rollback drill summaries with the backup set they
  describe.

## Bench rollback drill

Run this drill with synthetic data only:

```bash
node scripts/appliance-backup-rollback-audit.mjs drill \
  --work-dir /tmp/openclaw-appliance-drill/work \
  --cold-storage /tmp/openclaw-appliance-drill/cold-storage \
  --audit-log /tmp/openclaw-appliance-drill/audit.jsonl \
  --json
```

The drill creates a clean working copy, archives it, deliberately corrupts it,
restores from cold storage, verifies the clean state, and writes audit events for
archive creation, rollback completion, and drill completion.

Done criteria for a bench host:

- A verified `backup` run exists in the backup directory.
- At least one `drill` run returns `"passed": true`.
- The audit log contains `plugin.write.archive.created`,
  `plugin.write.rollback.completed`, and `rollback.drill.completed` events for
  the drill operation.

## Related

- [Backup](/cli/backup)
- [Approvals](/cli/approvals)
- [Exec approvals](/tools/exec-approvals)
