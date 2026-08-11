/**
 * Durable generation indirection used by source purge/rebuild.
 *
 * Existing wikis keep using their legacy project directory until the first
 * successful purge.  A purge builds a fresh sibling generation underneath the
 * wiki storage root and atomically publishes a small pointer file.  All normal
 * WikiService paths resolve that pointer, so no caller can observe a partially
 * copied generation.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const SOURCE_PURGE_DIR = ".source-purge";
export const SOURCE_PURGE_GENERATIONS_DIR = "generations";
export const SOURCE_PURGE_OPERATIONS_DIR = "operations";
export const SOURCE_PURGE_ACTIVE_OPERATION = "active-operation.json";
export const SOURCE_PURGE_ACTIVE_GENERATION = "active-generation.json";

const SEGMENT_RE = /^[A-Za-z0-9_-]{1,200}$/;

export interface ActiveGenerationPointer {
  schema_version: 1;
  generation_id: string;
  operation_id: string;
  activated_at: string;
}

export function wikiStorageRoot(
  dataRoot: string,
  serviceId: string,
  teamId: string,
  wikiId: string,
): string {
  return join(dataRoot, serviceId, teamId, wikiId);
}

export function sourcePurgeControlDir(storageRoot: string): string {
  return join(storageRoot, SOURCE_PURGE_DIR);
}

export function sourcePurgeGenerationsDir(storageRoot: string): string {
  return join(sourcePurgeControlDir(storageRoot), SOURCE_PURGE_GENERATIONS_DIR);
}

export function sourcePurgeOperationsDir(storageRoot: string): string {
  return join(sourcePurgeControlDir(storageRoot), SOURCE_PURGE_OPERATIONS_DIR);
}

export function activeOperationPath(storageRoot: string): string {
  return join(sourcePurgeControlDir(storageRoot), SOURCE_PURGE_ACTIVE_OPERATION);
}

export function activeGenerationPath(storageRoot: string): string {
  return join(sourcePurgeControlDir(storageRoot), SOURCE_PURGE_ACTIVE_GENERATION);
}

export function hasActiveSourcePurge(storageRoot: string): boolean {
  return existsSync(activeOperationPath(storageRoot));
}

/** Create and verify the private control tree without following symlinks. */
export function assertSafeSourcePurgeLayout(storageRoot: string): void {
  const rootStat = lstatSync(storageRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("wiki storage root must be a real directory");
  }
  const dirs = [
    sourcePurgeControlDir(storageRoot),
    sourcePurgeGenerationsDir(storageRoot),
    sourcePurgeOperationsDir(storageRoot),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`source purge control path must be a real directory: ${dir}`);
    }
    if (stat.dev !== rootStat.dev) {
      throw new Error(`source purge control path crosses filesystems: ${dir}`);
    }
  }
  const controlMode = lstatSync(sourcePurgeControlDir(storageRoot)).mode & 0o777;
  if ((controlMode & 0o077) !== 0) {
    throw new Error("source purge control directory must not grant group/other access");
  }
}

export function readActiveGeneration(storageRoot: string): ActiveGenerationPointer | null {
  const pointerPath = activeGenerationPath(storageRoot);
  if (!existsSync(pointerPath)) return null;
  for (const dir of [sourcePurgeControlDir(storageRoot), sourcePurgeGenerationsDir(storageRoot)]) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`invalid active generation layout: real directory required at ${dir}`);
    }
  }
  const pointerStat = lstatSync(pointerPath);
  if (!pointerStat.isFile() || pointerStat.isSymbolicLink()) {
    throw new Error("invalid active generation pointer: regular file required");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pointerPath, "utf-8"));
  } catch (err) {
    throw new Error(`invalid active generation pointer: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid active generation pointer: object required");
  }
  const p = parsed as Record<string, unknown>;
  if (
    p.schema_version !== 1 ||
    typeof p.generation_id !== "string" ||
    !SEGMENT_RE.test(p.generation_id) ||
    typeof p.operation_id !== "string" ||
    !SEGMENT_RE.test(p.operation_id) ||
    typeof p.activated_at !== "string"
  ) {
    throw new Error("invalid active generation pointer: schema mismatch");
  }

  const generationDir = resolve(sourcePurgeGenerationsDir(storageRoot), p.generation_id);
  const generationsRoot = resolve(sourcePurgeGenerationsDir(storageRoot));
  if (!generationDir.startsWith(`${generationsRoot}/`)) {
    throw new Error("invalid active generation pointer: path escape");
  }
  if (!existsSync(generationDir)) {
    throw new Error(`active generation missing: ${p.generation_id}`);
  }
  const generationStat = lstatSync(generationDir);
  if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) {
    throw new Error(`active generation must be a real directory: ${p.generation_id}`);
  }
  const realGeneration = realpathSync(generationDir);
  const realRoot = realpathSync(generationsRoot);
  if (!realGeneration.startsWith(`${realRoot}/`)) {
    throw new Error("active generation escaped the generations directory");
  }
  return p as unknown as ActiveGenerationPointer;
}

export function resolveActiveWikiDir(storageRoot: string): string {
  const active = readActiveGeneration(storageRoot);
  return active
    ? join(sourcePurgeGenerationsDir(storageRoot), active.generation_id)
    : storageRoot;
}

/** Durable JSON replace: fsync file, rename, then fsync the containing directory. */
export function atomicWriteJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temp = join(parent, `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    fsyncDirectory(parent);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/** Durable create-if-absent. Returns false without replacing an existing file. */
export function createJsonExclusive(path: string, value: unknown): boolean {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(parent);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export function durableUnlink(path: string): void {
  try {
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
