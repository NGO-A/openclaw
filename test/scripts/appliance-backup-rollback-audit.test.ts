import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOpenClawBackupArgs,
  createPluginWriteArchive,
  pruneBackupArchives,
  resolveOpenClawBackupInvocation,
  runVerifiedBackup,
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
  it("archives original files before plugin writes and restores them under an allowed root", async () => {
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
      allowedTargetRoots: [root],
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
      allowedTargetRoots: [root],
      approvedBy: "John",
    });

    await expect(fs.stat(liveFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(archive.manifest.entries[0]).toMatchObject({
      targetPath: liveFile,
      originalExists: false,
      originalType: "missing",
    });
  });

  it("rejects plugin and operation ids that are not safe path segments", async () => {
    const root = await makeTempDir();
    const liveFile = path.join(root, "files", "matter.txt");
    const coldStorageDir = path.join(root, "cold-storage");
    await fs.mkdir(path.dirname(liveFile), { recursive: true });
    await fs.writeFile(liveFile, "original\n", "utf8");

    await expect(
      createPluginWriteArchive({
        coldStorageDir,
        writeSet: {
          operationId: "op-1",
          plugin: "../escape",
          files: [liveFile],
        },
      }),
    ).rejects.toThrow(/plugin must be a safe path segment/u);

    await expect(
      createPluginWriteArchive({
        coldStorageDir,
        writeSet: {
          operationId: "../escape",
          plugin: "file-reorg",
          files: [liveFile],
        },
      }),
    ).rejects.toThrow(/operationId must be a safe path segment/u);
    await expect(fs.stat(path.join(root, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects restore archives with traversal or absolute archive paths", async () => {
    const root = await makeTempDir();
    const liveFile = path.join(root, "files", "matter.txt");
    const auditLogPath = path.join(root, "audit.jsonl");
    await fs.mkdir(path.dirname(liveFile), { recursive: true });
    await fs.writeFile(liveFile, "original\n", "utf8");

    for (const archivePath of ["../escape.file", path.join(root, "escape.file")]) {
      const storageKind = archivePath.startsWith("..") ? "relative" : "absolute";
      const archive = await createPluginWriteArchive({
        coldStorageDir: path.join(root, `cold-${storageKind}`),
        auditLogPath,
        writeSet: {
          operationId: `op-${storageKind}`,
          plugin: "file-reorg",
          files: [liveFile],
        },
      });
      await fs.writeFile(liveFile, "corrupted\n", "utf8");
      archive.manifest.entries[0].archivePath = archivePath;
      await fs.writeFile(
        archive.manifestPath,
        `${JSON.stringify(archive.manifest, null, 2)}\n`,
        "utf8",
      );

      await expect(
        restorePluginWriteArchive({
          archivePath: archive.archivePath,
          auditLogPath,
          allowedTargetRoots: [root],
          approvedBy: "John",
        }),
      ).rejects.toThrow(/archivePath/u);
      await expect(fs.readFile(liveFile, "utf8")).resolves.toBe("corrupted\n");
    }
  });

  it("validates all restore manifest entries before deleting missing-original targets", async () => {
    const root = await makeTempDir();
    const missingThenCreated = path.join(root, "files", "created.txt");
    const existingFile = path.join(root, "files", "existing.txt");
    const auditLogPath = path.join(root, "audit.jsonl");
    await fs.mkdir(path.dirname(existingFile), { recursive: true });
    await fs.writeFile(existingFile, "original\n", "utf8");

    const archive = await createPluginWriteArchive({
      coldStorageDir: path.join(root, "cold"),
      auditLogPath,
      writeSet: {
        operationId: "op-validate-first",
        plugin: "file-reorg",
        files: [missingThenCreated, existingFile],
      },
    });
    await fs.writeFile(missingThenCreated, "created after archive\n", "utf8");
    archive.manifest.entries[1].archivePath = "../escape.file";
    await fs.writeFile(archive.manifestPath, `${JSON.stringify(archive.manifest, null, 2)}\n`);

    await expect(
      restorePluginWriteArchive({
        archivePath: archive.archivePath,
        auditLogPath,
        allowedTargetRoots: [root],
        approvedBy: "John",
      }),
    ).rejects.toThrow(/archivePath/u);
    await expect(fs.readFile(missingThenCreated, "utf8")).resolves.toBe(
      "created after archive\n",
    );
  });

  it("rejects tampered manifest target paths outside allowed roots before deleting", async () => {
    const root = await makeTempDir();
    const allowedRoot = path.join(root, "allowed");
    const outsideRoot = path.join(root, "outside");
    const missingThenCreated = path.join(allowedRoot, "created.txt");
    const outsideVictim = path.join(outsideRoot, "victim.txt");
    const auditLogPath = path.join(root, "audit.jsonl");
    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(outsideVictim, "must survive\n", "utf8");

    const archive = await createPluginWriteArchive({
      coldStorageDir: path.join(root, "cold"),
      auditLogPath,
      writeSet: {
        operationId: "op-tampered-target",
        plugin: "file-reorg",
        files: [missingThenCreated],
      },
    });
    await fs.writeFile(missingThenCreated, "created after archive\n", "utf8");
    archive.manifest.entries[0].targetPath = outsideVictim;
    archive.manifest.entries[0].targetPathSha256 = crypto
      .createHash("sha256")
      .update(outsideVictim)
      .digest("hex");
    await fs.writeFile(archive.manifestPath, `${JSON.stringify(archive.manifest, null, 2)}\n`);

    await expect(
      restorePluginWriteArchive({
        archivePath: archive.archivePath,
        auditLogPath,
        allowedTargetRoots: [allowedRoot],
        approvedBy: "John",
      }),
    ).rejects.toThrow(/allowed target root/u);
    await expect(fs.readFile(outsideVictim, "utf8")).resolves.toBe("must survive\n");
    await expect(fs.readFile(missingThenCreated, "utf8")).resolves.toBe("created after archive\n");
  });

  it("rejects restore targets that escape allowed roots through symlink ancestors", async () => {
    const root = await makeTempDir();
    const allowedRoot = path.join(root, "allowed");
    const outsideRoot = path.join(root, "outside");
    const symlinkRoot = path.join(allowedRoot, "link");
    const linkedTarget = path.join(symlinkRoot, "victim.txt");
    const outsideVictim = path.join(outsideRoot, "victim.txt");
    const auditLogPath = path.join(root, "audit.jsonl");
    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.symlink(outsideRoot, symlinkRoot);

    const archive = await createPluginWriteArchive({
      coldStorageDir: path.join(root, "cold"),
      auditLogPath,
      writeSet: {
        operationId: "op-symlink-target",
        plugin: "file-reorg",
        files: [linkedTarget],
      },
    });
    await fs.writeFile(outsideVictim, "must survive\n", "utf8");

    await expect(
      restorePluginWriteArchive({
        archivePath: archive.archivePath,
        auditLogPath,
        allowedTargetRoots: [allowedRoot],
        approvedBy: "John",
      }),
    ).rejects.toThrow(/allowed target root/u);
    await expect(fs.readFile(outsideVictim, "utf8")).resolves.toBe("must survive\n");
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

  it("wraps verified backups with stable args and audit metadata", async () => {
    const root = await makeTempDir();
    const outputDir = path.join(root, "backups");
    const auditLogPath = path.join(root, "audit", "appliance.jsonl");
    const backupCalls: Array<{
      outputDir: string;
      dryRun: boolean;
      noIncludeWorkspace: boolean;
      args: string[];
    }> = [];

    const result = await runVerifiedBackup({
      outputDir,
      auditLogPath,
      dryRun: true,
      noIncludeWorkspace: true,
      retentionCount: 7,
      retentionDays: 30,
      backupRunner: async ({ outputDir: resolvedOutputDir, dryRun, noIncludeWorkspace }) => {
        backupCalls.push({
          outputDir: resolvedOutputDir,
          dryRun,
          noIncludeWorkspace,
          args: buildOpenClawBackupArgs(resolvedOutputDir, dryRun, noIncludeWorkspace),
        });
        return { stdout: "{\"ok\":true}\n", stderr: "" };
      },
    });

    expect(result).toMatchObject({
      outputDir,
      noIncludeWorkspace: true,
      pruning: expect.objectContaining({
        dryRun: true,
        retentionCount: 7,
        retentionDays: 30,
      }),
    });
    expect(backupCalls).toEqual([
      {
        outputDir,
        dryRun: true,
        noIncludeWorkspace: true,
        args: [
          "backup",
          "create",
          "--output",
          outputDir,
          "--verify",
          "--json",
          "--no-include-workspace",
          "--dry-run",
        ],
      },
    ]);
    expect(await readAuditEvents(auditLogPath)).toEqual([
      expect.objectContaining({
        event: "appliance.backup.completed",
        outputDir,
        retentionCount: 7,
        retentionDays: 30,
        dryRun: true,
        noIncludeWorkspace: true,
      }),
    ]);
  });

  it("selects a global openclaw command from PATH before the pnpm fallback", async () => {
    const root = await makeTempDir();
    const binDir = path.join(root, "bin");
    const openclawPath = path.join(binDir, "openclaw");
    const outputDir = path.join(root, "backups");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(openclawPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(openclawPath, 0o755);

    await expect(
      resolveOpenClawBackupInvocation({
        outputDir,
        dryRun: true,
        noIncludeWorkspace: true,
        env: { PATH: binDir },
      }),
    ).resolves.toEqual({
      command: openclawPath,
      source: "path",
      args: [
        "backup",
        "create",
        "--output",
        outputDir,
        "--verify",
        "--json",
        "--no-include-workspace",
        "--dry-run",
      ],
    });
  });

  it("prefers an explicit appliance backup command from the environment", async () => {
    const root = await makeTempDir();
    const outputDir = path.join(root, "backups");
    const command = path.join(root, "custom-openclaw");

    await expect(
      resolveOpenClawBackupInvocation({
        outputDir,
        dryRun: false,
        noIncludeWorkspace: false,
        env: { OPENCLAW_APPLIANCE_BACKUP_COMMAND: command, PATH: "" },
      }),
    ).resolves.toEqual({
      command,
      source: "override",
      args: ["backup", "create", "--output", outputDir, "--verify", "--json"],
    });
  });

  it("falls back to pnpm openclaw when no openclaw command is available", async () => {
    const root = await makeTempDir();
    const outputDir = path.join(root, "backups");

    await expect(
      resolveOpenClawBackupInvocation({
        outputDir,
        dryRun: false,
        noIncludeWorkspace: false,
        env: { PATH: path.join(root, "missing-bin") },
      }),
    ).resolves.toEqual({
      command: "pnpm",
      source: "pnpm-fallback",
      args: ["openclaw", "backup", "create", "--output", outputDir, "--verify", "--json"],
    });
  });
});
