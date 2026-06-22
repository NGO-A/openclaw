import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginWriteArchive,
  pruneBackupArchives,
  restorePluginWriteArchive,
  runRollbackDrill,
} from "../../scripts/appliance-backup-rollback-audit.mjs";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-appliance-ops-"));
  tempDirs.push(dir);
  return dir;
}

async function readAuditEvents(auditLogPath: string) {
  const raw = await fs.readFile(auditLogPath, "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("appliance backup rollback audit helpers", () => {
  it("archives original files before plugin writes and restores them during rollback", async () => {
    const root = await makeTempDir();
    const liveFile = path.join(root, "files", "matter.txt");
    const coldStorageDir = path.join(root, "cold-storage");
    const auditLogPath = path.join(root, "audit", "appliance.jsonl");
    await fs.mkdir(path.dirname(liveFile), { recursive: true });
    await fs.writeFile(liveFile, "original\n", "utf8");

    const archive = await createPluginWriteArchive({
      coldStorageDir,
      auditLogPath,
      writeSet: {
        operationId: "op-1",
        plugin: "file-reorg",
        approvedBy: "John",
        approvalId: "approval-1",
        reason: "bench test",
        files: [liveFile],
      },
    });
    await fs.writeFile(liveFile, "corrupted\n", "utf8");

    const restored = await restorePluginWriteArchive({
      archivePath: archive.archivePath,
      auditLogPath,
      approvedBy: "John",
      approvalId: "approval-rollback-1",
      reason: "rollback drill",
    });

    await expect(fs.readFile(liveFile, "utf8")).resolves.toBe("original\n");
    expect(restored.restored).toHaveLength(1);
    expect(archive.manifest.entries[0]).toMatchObject({
      targetPath: liveFile,
      originalExists: true,
      originalType: "file",
      originalBytes: "original\n".length,
    });
    expect(archive.manifest.entries[0].originalSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readAuditEvents(auditLogPath)).toEqual([
      expect.objectContaining({
        event: "plugin.write.archive.created",
        operationId: "op-1",
        plugin: "file-reorg",
        targetCount: 1,
      }),
      expect.objectContaining({
        event: "plugin.write.rollback.completed",
        operationId: "op-1",
        plugin: "file-reorg",
        restoredCount: 1,
      }),
    ]);
  });

  it("removes files that were created after an archive recorded a missing original", async () => {
    const root = await makeTempDir();
    const liveFile = path.join(root, "files", "new-file.txt");
    const auditLogPath = path.join(root, "audit.jsonl");
    await fs.mkdir(path.dirname(liveFile), { recursive: true });

    const archive = await createPluginWriteArchive({
      coldStorageDir: path.join(root, "cold"),
      auditLogPath,
      writeSet: {
        operationId: "op-missing",
        plugin: "file-reorg",
        files: [liveFile],
      },
    });
    await fs.writeFile(liveFile, "new live bytes\n", "utf8");

    await restorePluginWriteArchive({
      archivePath: archive.archivePath,
      auditLogPath,
      approvedBy: "John",
    });

    await expect(fs.stat(liveFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(archive.manifest.entries[0]).toMatchObject({
      targetPath: liveFile,
      originalExists: false,
      originalType: "missing",
    });
  });

  it("runs a synthetic rollback drill with no client data", async () => {
    const root = await makeTempDir();
    const result = await runRollbackDrill({
      workDir: path.join(root, "work"),
      coldStorageDir: path.join(root, "cold"),
      auditLogPath: path.join(root, "audit", "appliance.jsonl"),
    });

    expect(result).toMatchObject({
      passed: true,
      restoredCount: 1,
    });
    await expect(fs.readFile(result.workingFile, "utf8")).resolves.toBe(
      "clean appliance rollback drill fixture\n",
    );
    const events = await readAuditEvents(path.join(root, "audit", "appliance.jsonl"));
    expect(events.map((event) => event.event)).toEqual([
      "plugin.write.archive.created",
      "plugin.write.rollback.completed",
      "rollback.drill.completed",
    ]);
  });

  it("prunes old verified backup archives while keeping recent count and age windows", async () => {
    const root = await makeTempDir();
    const nowMs = Date.UTC(2026, 5, 22);
    const archiveNames = [
      "2026-06-20T00-00-00.000Z-openclaw-backup.tar.gz",
      "2026-06-18T00-00-00.000Z-openclaw-backup.tar.gz",
      "2026-01-01T00-00-00.000Z-openclaw-backup.tar.gz",
      "2025-12-01T00-00-00.000Z-openclaw-backup.tar.gz",
    ];
    const archiveMtimes = [
      Date.UTC(2026, 5, 20),
      Date.UTC(2026, 5, 18),
      Date.UTC(2026, 0, 1),
      Date.UTC(2025, 11, 1),
    ];
    for (const [index, name] of archiveNames.entries()) {
      const archivePath = path.join(root, name);
      await fs.writeFile(archivePath, `archive-${index}`);
      await fs.utimes(archivePath, archiveMtimes[index] / 1000, archiveMtimes[index] / 1000);
    }
    await fs.writeFile(path.join(root, "notes.txt"), "not an archive");

    const result = await pruneBackupArchives({
      backupDir: root,
      retentionCount: 2,
      retentionDays: 30,
      nowMs,
    });

    expect(result.deleted.map((deletedPath) => path.basename(deletedPath))).toEqual([
      "2026-01-01T00-00-00.000Z-openclaw-backup.tar.gz",
      "2025-12-01T00-00-00.000Z-openclaw-backup.tar.gz",
    ]);
    await expect(fs.stat(path.join(root, archiveNames[0]))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, archiveNames[1]))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, archiveNames[2]))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
