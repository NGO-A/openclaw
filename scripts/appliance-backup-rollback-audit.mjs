#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const BACKUP_ARCHIVE_PATTERN = /openclaw-backup\.tar\.gz$/u;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function usage() {
  return `Usage:
  node scripts/appliance-backup-rollback-audit.mjs backup --output <dir> [--retention-count 14] [--retention-days 90] [--audit-log <file>] [--dry-run] [--no-include-workspace] [--json]
  node scripts/appliance-backup-rollback-audit.mjs archive --manifest <file> --cold-storage <dir> --audit-log <file> [--plugin <id>] [--approved-by <name>] [--approval-id <id>] [--reason <text>] [--json]
  node scripts/appliance-backup-rollback-audit.mjs restore --archive <dir> --audit-log <file> [--approved-by <name>] [--approval-id <id>] [--reason <text>] [--json]
  node scripts/appliance-backup-rollback-audit.mjs drill --work-dir <dir> --cold-storage <dir> --audit-log <file> [--json]
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      opts._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      opts[name] = true;
      continue;
    }
    opts[name] = next;
    i += 1;
  }
  return { command, opts };
}

function requireString(opts, name) {
  const value = opts[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function optionalString(opts, name) {
  const value = opts[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalInteger(opts, name, fallback) {
  const value = opts[name];
  if (value === undefined || value === true) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function assertAbsoluteSafePath(targetPath) {
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    throw new Error("write-set path must be a non-empty string");
  }
  if (targetPath.includes("\0")) {
    throw new Error(`write-set path must not contain NUL bytes: ${targetPath}`);
  }
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`write-set path must be absolute: ${targetPath}`);
  }
  return path.resolve(targetPath);
}

function assertSafePathSegment(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty path segment`);
  }
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain NUL bytes`);
  }
  if (
    value === "." ||
    value === ".." ||
    path.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    !SAFE_PATH_SEGMENT_PATTERN.test(value)
  ) {
    throw new Error(`${label} must be a safe path segment: ${value}`);
  }
  return value;
}

function assertPathInside(parentPath, targetPath, label) {
  const parent = path.resolve(parentPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return target;
  }
  throw new Error(`${label} must remain under ${parent}`);
}

function assertArchiveRelativePath(archiveRoot, archivePath) {
  if (typeof archivePath !== "string" || archivePath.trim() === "") {
    throw new Error("archivePath must be a non-empty relative path");
  }
  if (archivePath.includes("\0")) {
    throw new Error(`archivePath must not contain NUL bytes: ${archivePath}`);
  }
  if (path.isAbsolute(archivePath) || archivePath.includes("\\")) {
    throw new Error(`archivePath must be a relative archive member path: ${archivePath}`);
  }
  const sourcePath = path.resolve(archiveRoot, archivePath);
  return assertPathInside(archiveRoot, sourcePath, `archivePath ${archivePath}`);
}

function timestampForPath(now = new Date()) {
  return now.toISOString().replaceAll(":", "-");
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function operationId(prefix = "op") {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

async function pathStat(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function hashFile(filePath) {
  return sha256Hex(await fs.readFile(filePath));
}

function entryArchiveRelativePath(index, targetPath, stat) {
  const basename = path.basename(targetPath) || `entry-${index}`;
  const suffix = stat?.isDirectory() ? ".dir" : ".file";
  return path.join("originals", `${String(index).padStart(4, "0")}-${basename}${suffix}`);
}

async function copyOriginalToArchive(params) {
  const { archiveRoot, archiveRelativePath, stat, targetPath } = params;
  if (!stat) {
    return;
  }
  const archivePath = path.join(archiveRoot, archiveRelativePath);
  await fs.mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });
  if (stat.isDirectory()) {
    await fs.cp(targetPath, archivePath, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    return;
  }
  if (stat.isFile()) {
    await fs.copyFile(targetPath, archivePath);
    await fs.chmod(archivePath, stat.mode & 0o777).catch(() => undefined);
    return;
  }
  throw new Error(`Unsupported original type for rollback archive: ${targetPath}`);
}

async function buildArchivedEntry(params) {
  const { archiveRoot, index, targetPath } = params;
  const stat = await pathStat(targetPath);
  const archiveRelativePath = stat ? entryArchiveRelativePath(index, targetPath, stat) : null;
  if (archiveRelativePath) {
    await copyOriginalToArchive({ archiveRoot, archiveRelativePath, stat, targetPath });
  }
  const fileHash = stat?.isFile() ? await hashFile(targetPath) : null;
  return {
    targetPath,
    targetPathSha256: sha256Hex(targetPath),
    originalExists: Boolean(stat),
    originalType: stat ? (stat.isDirectory() ? "directory" : "file") : "missing",
    archivePath: archiveRelativePath,
    originalBytes: stat?.isFile() ? stat.size : null,
    originalSha256: fileHash,
    originalMode: stat ? stat.mode & 0o777 : null,
    archivedAt: new Date().toISOString(),
  };
}

async function appendAuditEvent(auditLogPath, event) {
  if (!auditLogPath) {
    return;
  }
  const resolved = path.resolve(auditLogPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await fs.appendFile(
    resolved,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      source: "appliance-backup-rollback-audit",
      ...event,
    })}\n`,
    { mode: 0o600 },
  );
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function normalizeWriteSet(raw, overrides = {}) {
  const files = Array.isArray(raw?.files) ? raw.files : Array.isArray(raw?.paths) ? raw.paths : [];
  if (files.length === 0) {
    throw new Error("write-set manifest must contain a non-empty files or paths array");
  }
  const operation = assertSafePathSegment(
    typeof raw?.operationId === "string" && raw.operationId.trim()
      ? raw.operationId
      : operationId("write"),
    "operationId",
  );
  const plugin = assertSafePathSegment(
    overrides.plugin ??
      (typeof raw?.plugin === "string" && raw.plugin.trim() ? raw.plugin : "unknown-plugin"),
    "plugin",
  );
  return {
    operationId: operation,
    plugin,
    approvedBy:
      overrides.approvedBy ??
      (typeof raw?.approvedBy === "string" && raw.approvedBy.trim() ? raw.approvedBy : null),
    approvalId:
      overrides.approvalId ??
      (typeof raw?.approvalId === "string" && raw.approvalId.trim() ? raw.approvalId : null),
    reason:
      overrides.reason ??
      (typeof raw?.reason === "string" && raw.reason.trim() ? raw.reason : null),
    files: files.map((entry) =>
      assertAbsoluteSafePath(typeof entry === "string" ? entry : entry?.path),
    ),
  };
}

export async function createPluginWriteArchive(params) {
  const coldStorageDir = path.resolve(params.coldStorageDir);
  const writeSet = normalizeWriteSet(params.writeSet, {
    plugin: params.plugin,
    approvedBy: params.approvedBy,
    approvalId: params.approvalId,
    reason: params.reason,
  });
  const archiveRoot = assertPathInside(
    coldStorageDir,
    path.join(coldStorageDir, writeSet.plugin, `${timestampForPath()}-${writeSet.operationId}`),
    "archiveRoot",
  );
  await fs.mkdir(path.dirname(archiveRoot), { recursive: true, mode: 0o700 });
  await fs.mkdir(archiveRoot, { recursive: false, mode: 0o700 });
  const entries = [];
  for (const [index, targetPath] of writeSet.files.entries()) {
    entries.push(await buildArchivedEntry({ archiveRoot, index, targetPath }));
  }
  const manifest = {
    schemaVersion: 1,
    kind: "openclaw-appliance-plugin-write-archive",
    operationId: writeSet.operationId,
    plugin: writeSet.plugin,
    approval: {
      approvedBy: writeSet.approvedBy,
      approvalId: writeSet.approvalId,
      reason: writeSet.reason,
    },
    createdAt: new Date().toISOString(),
    host: os.hostname(),
    entries,
  };
  const manifestPath = path.join(archiveRoot, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await appendAuditEvent(params.auditLogPath, {
    event: "plugin.write.archive.created",
    operationId: manifest.operationId,
    plugin: manifest.plugin,
    approval: manifest.approval,
    archivePath: archiveRoot,
    targetCount: entries.length,
    existingOriginalCount: entries.filter((entry) => entry.originalExists).length,
  });
  return { archivePath: archiveRoot, manifestPath, manifest };
}

function validateArchiveManifestEntry(archiveRoot, rawEntry, index) {
  if (!rawEntry || typeof rawEntry !== "object") {
    throw new Error(`Archive manifest entry ${index} must be an object`);
  }
  const targetPath = assertAbsoluteSafePath(rawEntry.targetPath);
  if (!/^[a-f0-9]{64}$/u.test(rawEntry.targetPathSha256)) {
    throw new Error(`Archive manifest entry ${index} targetPathSha256 must be a sha256 hex digest`);
  }
  if (rawEntry.targetPathSha256 !== sha256Hex(targetPath)) {
    throw new Error(`Archive manifest entry ${index} targetPath hash does not match targetPath`);
  }
  if (rawEntry.originalExists !== true && rawEntry.originalExists !== false) {
    throw new Error(`Archive manifest entry ${index} originalExists must be boolean`);
  }
  if (!["file", "directory", "missing"].includes(rawEntry.originalType)) {
    throw new Error(`Archive manifest entry ${index} has unsupported originalType`);
  }
  if (!rawEntry.originalExists && rawEntry.originalType !== "missing") {
    throw new Error(
      `Archive manifest entry ${index} missing originals must use originalType=missing`,
    );
  }
  if (rawEntry.originalExists && rawEntry.originalType === "missing") {
    throw new Error(
      `Archive manifest entry ${index} existing originals must not use originalType=missing`,
    );
  }
  if (!rawEntry.originalExists && rawEntry.archivePath != null) {
    throw new Error(`Archive manifest entry ${index} missing originals must not have archivePath`);
  }
  const sourcePath = rawEntry.originalExists
    ? assertArchiveRelativePath(archiveRoot, rawEntry.archivePath)
    : null;
  if (rawEntry.originalType === "file") {
    if (rawEntry.originalSha256 != null && !/^[a-f0-9]{64}$/u.test(rawEntry.originalSha256)) {
      throw new Error(`Archive manifest entry ${index} originalSha256 must be a sha256 hex digest`);
    }
    if (rawEntry.originalMode != null && !Number.isInteger(rawEntry.originalMode)) {
      throw new Error(`Archive manifest entry ${index} originalMode must be an integer`);
    }
  }
  return {
    targetPath,
    originalExists: rawEntry.originalExists,
    originalType: rawEntry.originalType,
    archivePath: rawEntry.archivePath ?? null,
    sourcePath,
    originalSha256: rawEntry.originalSha256 ?? null,
    originalMode: rawEntry.originalMode ?? null,
  };
}

function validateArchiveManifestEntries(archiveRoot, manifest) {
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  return entries.map((entry, index) => validateArchiveManifestEntry(archiveRoot, entry, index));
}

async function restoreEntry(entry) {
  const { targetPath } = entry;
  if (!entry.originalExists) {
    await fs.rm(targetPath, { recursive: true, force: true });
    return { targetPath, restored: "removed-created-path", verified: true };
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (entry.originalType === "directory") {
    await fs.rm(targetPath, { recursive: true, force: true });
    await fs.cp(entry.sourcePath, targetPath, {
      recursive: true,
      dereference: false,
      force: false,
      preserveTimestamps: true,
    });
    return { targetPath, restored: "directory", verified: true };
  }
  await fs.copyFile(entry.sourcePath, targetPath);
  if (Number.isInteger(entry.originalMode)) {
    await fs.chmod(targetPath, entry.originalMode).catch(() => undefined);
  }
  const restoredHash = await hashFile(targetPath);
  if (entry.originalSha256 && restoredHash !== entry.originalSha256) {
    throw new Error(`Rollback verification failed for ${targetPath}`);
  }
  return { targetPath, restored: "file", verified: true, sha256: restoredHash };
}

export async function restorePluginWriteArchive(params) {
  const archiveRoot = path.resolve(params.archivePath);
  const manifest = await readJsonFile(path.join(archiveRoot, "manifest.json"));
  if (manifest?.kind !== "openclaw-appliance-plugin-write-archive") {
    throw new Error(`Unsupported rollback archive manifest in ${archiveRoot}`);
  }
  const entries = validateArchiveManifestEntries(archiveRoot, manifest);
  const restored = [];
  for (const entry of entries.toReversed()) {
    restored.push(await restoreEntry(entry));
  }
  await appendAuditEvent(params.auditLogPath, {
    event: "plugin.write.rollback.completed",
    operationId: manifest.operationId,
    plugin: manifest.plugin,
    approval: {
      approvedBy: params.approvedBy ?? null,
      approvalId: params.approvalId ?? null,
      reason: params.reason ?? null,
    },
    archivePath: archiveRoot,
    targetCount: entries.length,
    restoredCount: restored.length,
  });
  return { archivePath: archiveRoot, manifest, restored };
}

export async function pruneBackupArchives(params) {
  const backupDir = path.resolve(params.backupDir);
  const retentionCount = params.retentionCount ?? 14;
  const retentionDays = params.retentionDays ?? 90;
  const nowMs = params.nowMs ?? Date.now();
  const dryRun = params.dryRun === true;
  const names = await fs.readdir(backupDir).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const archives = [];
  for (const name of names) {
    if (!BACKUP_ARCHIVE_PATTERN.test(name)) {
      continue;
    }
    const archivePath = path.join(backupDir, name);
    const stat = await fs.stat(archivePath).catch(() => null);
    if (stat?.isFile()) {
      archives.push({ path: archivePath, mtimeMs: stat.mtimeMs });
    }
  }
  archives.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
  );
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const keep = new Set(archives.slice(0, retentionCount).map((archive) => archive.path));
  const deleted = [];
  for (const archive of archives) {
    if (keep.has(archive.path) || archive.mtimeMs >= cutoffMs) {
      continue;
    }
    deleted.push(archive.path);
    if (!dryRun) {
      await fs.rm(archive.path, { force: true });
    }
  }
  return {
    backupDir,
    retentionCount,
    retentionDays,
    scannedCount: archives.length,
    deleted,
    dryRun,
  };
}

export function buildOpenClawBackupArgs(outputDir, dryRun, noIncludeWorkspace) {
  const args = ["openclaw", "backup", "create", "--output", outputDir, "--verify", "--json"];
  if (noIncludeWorkspace) {
    args.push("--no-include-workspace");
  }
  if (dryRun) {
    args.push("--dry-run");
  }
  return args;
}

function runPnpmOpenClawBackup(outputDir, dryRun, noIncludeWorkspace) {
  const args = buildOpenClawBackupArgs(outputDir, dryRun, noIncludeWorkspace);
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: process.cwd(),
      env: { ...process.env, XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? "/tmp/xdg" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`openclaw backup failed with exit ${code}: ${stderr || stdout}`));
    });
  });
}

export async function runVerifiedBackup(params) {
  const outputDir = path.resolve(params.outputDir);
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const backupRunner = params.backupRunner ?? runPnpmOpenClawBackup;
  const backup = await backupRunner(
    outputDir,
    params.dryRun === true,
    params.noIncludeWorkspace === true,
  );
  const pruning = await pruneBackupArchives({
    backupDir: outputDir,
    retentionCount: params.retentionCount,
    retentionDays: params.retentionDays,
    dryRun: params.dryRun,
  });
  await appendAuditEvent(params.auditLogPath, {
    event: "appliance.backup.completed",
    outputDir,
    retentionCount: pruning.retentionCount,
    retentionDays: pruning.retentionDays,
    prunedCount: pruning.deleted.length,
    dryRun: params.dryRun === true,
    noIncludeWorkspace: params.noIncludeWorkspace === true,
  });
  return { outputDir, backup, pruning, noIncludeWorkspace: params.noIncludeWorkspace === true };
}

export async function runRollbackDrill(params) {
  const workDir = path.resolve(params.workDir);
  const coldStorageDir = path.resolve(params.coldStorageDir);
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
  const workingFile = path.join(workDir, "working-copy.txt");
  const cleanContent = "clean appliance rollback drill fixture\n";
  const corruptContent = "corrupted appliance rollback drill fixture\n";
  await fs.writeFile(workingFile, cleanContent, { mode: 0o600 });
  const archive = await createPluginWriteArchive({
    coldStorageDir,
    auditLogPath: params.auditLogPath,
    writeSet: {
      operationId: operationId("drill"),
      plugin: "appliance-rollback-drill",
      approvedBy: "bench-drill",
      approvalId: "bench-drill",
      reason: "synthetic rollback drill",
      files: [workingFile],
    },
  });
  await fs.writeFile(workingFile, corruptContent, { mode: 0o600 });
  const corruptedSha256 = await hashFile(workingFile);
  const restored = await restorePluginWriteArchive({
    archivePath: archive.archivePath,
    auditLogPath: params.auditLogPath,
    approvedBy: "bench-drill",
    approvalId: "bench-drill",
    reason: "restore synthetic corruption",
  });
  const finalContent = await fs.readFile(workingFile, "utf8");
  const passed = finalContent === cleanContent;
  await appendAuditEvent(params.auditLogPath, {
    event: "rollback.drill.completed",
    operationId: archive.manifest.operationId,
    plugin: "appliance-rollback-drill",
    archivePath: archive.archivePath,
    workingFile,
    corruptedSha256,
    restoredSha256: await hashFile(workingFile),
    passed,
  });
  if (!passed) {
    throw new Error("Rollback drill failed: restored file did not match clean fixture");
  }
  return {
    passed,
    workingFile,
    archivePath: archive.archivePath,
    restoredCount: restored.restored.length,
  };
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  try {
    let result;
    switch (command) {
      case "backup":
        result = await runVerifiedBackup({
          outputDir: requireString(opts, "output"),
          auditLogPath: optionalString(opts, "audit-log"),
          retentionCount: optionalInteger(opts, "retention-count", 14),
          retentionDays: optionalInteger(opts, "retention-days", 90),
          dryRun: opts["dry-run"] === true,
          noIncludeWorkspace: opts["no-include-workspace"] === true,
        });
        break;
      case "archive":
        result = await createPluginWriteArchive({
          coldStorageDir: requireString(opts, "cold-storage"),
          auditLogPath: requireString(opts, "audit-log"),
          writeSet: await readJsonFile(requireString(opts, "manifest")),
          plugin: optionalString(opts, "plugin"),
          approvedBy: optionalString(opts, "approved-by"),
          approvalId: optionalString(opts, "approval-id"),
          reason: optionalString(opts, "reason"),
        });
        break;
      case "restore":
        result = await restorePluginWriteArchive({
          archivePath: requireString(opts, "archive"),
          auditLogPath: requireString(opts, "audit-log"),
          approvedBy: optionalString(opts, "approved-by"),
          approvalId: optionalString(opts, "approval-id"),
          reason: optionalString(opts, "reason"),
        });
        break;
      case "drill":
        result = await runRollbackDrill({
          workDir: requireString(opts, "work-dir"),
          coldStorageDir: requireString(opts, "cold-storage"),
          auditLogPath: requireString(opts, "audit-log"),
        });
        break;
      default:
        process.stderr.write(usage());
        process.exitCode = 2;
        return;
    }
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${command} ok\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
