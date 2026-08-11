/**
 * Source-scoped purge by clean rebuild.
 *
 * This deliberately does not call the legacy raw/rm cascade.  It copies only
 * the exact remaining raw manifest to a same-filesystem staging generation,
 * forces every remaining source through ingest, validates the resulting
 * source/page/FTS/graph surfaces, and atomically publishes a generation
 * pointer.  The durable operation journal makes retries and crash recovery
 * deterministic.
 */

import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { readSources } from "../engines/wiki/ingest-v2/frontmatter.js";
import { listSources, withWriteDb } from "../engines/wiki/index-db.js";
import { tokenize } from "../engines/wiki/manager.js";
import { BuildQueue } from "./build-queue.js";
import type { IKnowledgeStore, WikiRow } from "./types.js";
import type { WikiService, WikiServiceLogger } from "./wiki-service.js";
import {
  activeGenerationPath,
  activeOperationPath,
  assertSafeSourcePurgeLayout,
  atomicWriteJson,
  createJsonExclusive,
  durableUnlink,
  fsyncDirectory,
  readActiveGeneration,
  resolveActiveWikiDir,
  sourcePurgeGenerationsDir,
  sourcePurgeOperationsDir,
} from "./wiki-generation.js";

const OPERATION_RE = /^[A-Za-z0-9_-]{16,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const GENERATION_RE = /^gen_[a-f0-9]{24}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_SOURCES = 2_000;
const MAX_TOTAL_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_MARKERS = 20;
const MAX_MARKER_BYTES = 512;

export interface SourceManifestEntry {
  filename: string;
  sha256: string;
  size: number;
}

export interface SourcePurgeRequest {
  operation_id: string;
  service_id: string;
  team_id: string;
  wiki_id: string;
  target: SourceManifestEntry;
  remaining_manifest: SourceManifestEntry[];
  /** Required unique strings that must disappear from pages, FTS and summary. */
  residue_markers: string[];
  requester_user_id?: string;
}

export interface SourcePurgeBuildContext {
  operationId: string;
  generationId: string;
  wikiId: string;
  serviceId: string;
  teamId: string;
  stagingDir: string;
  remainingManifest: SourceManifestEntry[];
  setInternalStatus: (status: string) => void;
}

export interface SourcePurgeBuildResult {
  pageCount: number;
}

export type SourcePurgeWorker = (ctx: SourcePurgeBuildContext) => Promise<SourcePurgeBuildResult>;
export type SourcePurgeActivator = (
  wikiId: string,
  generationDir: string,
) => SourcePurgeBuildResult;
export type SourcePurgeRetirer = (
  storageRoot: string,
  previousGenerationId: string | null,
  activeGenerationId: string,
) => void;

export interface SourcePurgeReceipt {
  schema_version: 1;
  operation_id: string;
  operation_fingerprint: string;
  wiki_id: string;
  team_id: string;
  deleted_source: SourceManifestEntry;
  remaining_manifest_sha256: string;
  remaining_source_count: number;
  generation_id: string;
  page_count: number;
  source_row_count: number;
  fts_row_count: number;
  graph_edge_count: number;
  residue_marker_sha256: string[];
  residue_matches: 0;
  summary_cleared: true;
  activated_at: string;
  completed_at: string;
}

type JournalPhase =
  | "accepted"
  | "copying_raw"
  | "building"
  | "validated"
  | "generation_published"
  | "cleaning_retired_generation"
  | "succeeded"
  | "failed";

interface SourcePurgeJournal {
  schema_version: 1;
  status: "pending" | "running" | "succeeded" | "failed";
  phase: JournalPhase;
  operation_id: string;
  operation_fingerprint: string;
  service_id: string;
  team_id: string;
  wiki_id: string;
  requester_user_id: string | null;
  target: SourceManifestEntry;
  remaining_manifest: SourceManifestEntry[];
  remaining_manifest_sha256: string;
  residue_markers: string[];
  residue_marker_sha256: string[];
  previous_summary_sha256: string | null;
  generation_id: string;
  previous_generation_id: string | null;
  previous_metadata: {
    status: WikiRow["status"];
    internal_status: string | null;
    sync_error: string | null;
    page_count: number | null;
    summary: string | null;
    last_sync_at: string | null;
  };
  created_at: string;
  updated_at: string;
  redacted_at?: string;
  last_error: string | null;
  validation?: Omit<SourcePurgeReceipt, "schema_version" | "operation_id" | "operation_fingerprint" | "wiki_id" | "team_id" | "deleted_source" | "remaining_manifest_sha256" | "remaining_source_count" | "generation_id" | "activated_at" | "completed_at">;
  receipt?: SourcePurgeReceipt;
}

export type SourcePurgeSubmitResult =
  | { kind: "accepted" | "existing"; operation: PublicSourcePurgeOperation }
  | { kind: "not_found" }
  | { kind: "busy"; operation_id?: string }
  | { kind: "invalid"; message: string }
  | { kind: "manifest_mismatch"; actual_manifest_sha256: string }
  | { kind: "operation_conflict" };

export interface PublicSourcePurgeOperation {
  operation_id: string;
  operation_fingerprint: string;
  status: SourcePurgeJournal["status"];
  phase: JournalPhase;
  receipt: SourcePurgeReceipt | null;
  error: string | null;
}

export interface WikiSourcePurgeServiceOptions {
  store: IKnowledgeStore;
  wikiService: WikiService;
  dataRoot: string;
  worker: SourcePurgeWorker;
  activateGeneration: SourcePurgeActivator;
  retireGeneration?: SourcePurgeRetirer;
  queue?: BuildQueue;
  logger?: WikiServiceLogger;
}

export class WikiSourcePurgeService {
  private readonly store: IKnowledgeStore;
  private readonly wikiService: WikiService;
  private readonly dataRoot: string;
  private readonly worker: SourcePurgeWorker;
  private readonly activateGeneration: SourcePurgeActivator;
  private readonly retireGeneration: SourcePurgeRetirer;
  private readonly queue: BuildQueue;
  private readonly logger?: WikiServiceLogger;

  constructor(opts: WikiSourcePurgeServiceOptions) {
    this.store = opts.store;
    this.wikiService = opts.wikiService;
    this.dataRoot = opts.dataRoot;
    this.worker = opts.worker;
    this.activateGeneration = opts.activateGeneration;
    this.retireGeneration = opts.retireGeneration ?? cleanupRetiredGeneration;
    this.queue = opts.queue ?? new BuildQueue();
    this.logger = opts.logger;
  }

  submit(request: SourcePurgeRequest): SourcePurgeSubmitResult {
    const invalid = validateRequest(request);
    if (invalid) return { kind: "invalid", message: invalid };

    const row = this.store.getWiki(request.service_id, request.team_id, request.wiki_id);
    if (!row) return { kind: "not_found" };
    const root = this.wikiService.storageRootFor(request.service_id, request.team_id, request.wiki_id);
    try {
      assertSafeSourcePurgeLayout(root);
    } catch (err) {
      return { kind: "invalid", message: `unsafe source purge storage layout: ${String(err)}` };
    }
    const journalPath = this.journalPath(root, request.operation_id);
    const fingerprint = operationFingerprint(request);

    if (existsSync(journalPath)) {
      const existing = this.readJournal(journalPath);
      if (existing.operation_fingerprint !== fingerprint) return { kind: "operation_conflict" };
      if (existing.status === "pending" || existing.status === "running") {
        const activePath = activeOperationPath(root);
        if (!existsSync(activePath)) {
          if (createJsonExclusive(activePath, activeOperationRecord(root, journalPath, existing))) {
            this.queue.enqueue(existing.wiki_id, () => this.run(journalPath));
          }
        } else {
          const active = readJsonRecord(activePath);
          if (
            active.operation_id !== existing.operation_id ||
            active.operation_fingerprint !== existing.operation_fingerprint
          ) {
            return { kind: "busy", operation_id: typeof active.operation_id === "string" ? active.operation_id : undefined };
          }
          // Idempotent retries also drive recovery. A duplicate queued behind an
          // already-running job exits immediately after observing its terminal
          // journal, so response-loss retries cannot rebuild twice.
          this.queue.enqueue(existing.wiki_id, () => this.run(journalPath));
        }
      }
      return { kind: "existing", operation: toPublic(existing) };
    }

    if (
      row.status === "pending" ||
      row.status === "processing" ||
      this.wikiService.hasInFlightMutation(request.service_id, request.team_id, request.wiki_id)
    ) {
      return { kind: "busy" };
    }

    const activePath = activeOperationPath(root);
    if (existsSync(activePath)) {
      const active = readJsonRecord(activePath);
      return {
        kind: "busy",
        operation_id: typeof active.operation_id === "string" ? active.operation_id : undefined,
      };
    }

    const currentDir = resolveActiveWikiDir(root);
    const actualManifest = scanRawManifest(currentDir);
    const expectedManifest = sortManifest([request.target, ...request.remaining_manifest]);
    if (!sameManifest(actualManifest, expectedManifest)) {
      return { kind: "manifest_mismatch", actual_manifest_sha256: manifestDigest(actualManifest) };
    }
    const markerError = validateMarkerPlacement(currentDir, request.target, request.remaining_manifest, request.residue_markers);
    if (markerError) return { kind: "invalid", message: markerError };

    const previous = readActiveGeneration(root);
    const now = new Date().toISOString();
    const journal: SourcePurgeJournal = {
      schema_version: 1,
      status: "pending",
      phase: "accepted",
      operation_id: request.operation_id,
      operation_fingerprint: fingerprint,
      service_id: request.service_id,
      team_id: request.team_id,
      wiki_id: request.wiki_id,
      requester_user_id: request.requester_user_id ?? null,
      target: request.target,
      remaining_manifest: sortManifest(request.remaining_manifest),
      remaining_manifest_sha256: manifestDigest(request.remaining_manifest),
      residue_markers: [...request.residue_markers],
      residue_marker_sha256: markerDigests(request.residue_markers),
      previous_summary_sha256: row.summary === null
        ? null
        : createHash("sha256").update(row.summary).digest("hex"),
      generation_id: `gen_${createHash("sha256").update(request.operation_id).digest("hex").slice(0, 24)}`,
      previous_generation_id: previous?.generation_id ?? null,
      previous_metadata: {
        status: row.status,
        internal_status: row.internal_status,
        sync_error: row.sync_error,
        page_count: row.page_count,
        summary: row.summary,
        last_sync_at: row.last_sync_at,
      },
      created_at: now,
      updated_at: now,
      last_error: null,
    };

    mkdirSync(dirname(journalPath), { recursive: true });
    if (!createJsonExclusive(journalPath, journal)) {
      const raced = this.readJournal(journalPath);
      return raced.operation_fingerprint === fingerprint
        ? { kind: "existing", operation: toPublic(raced) }
        : { kind: "operation_conflict" };
    }
    if (!createJsonExclusive(activePath, activeOperationRecord(root, journalPath, journal))) {
      journal.status = "failed";
      journal.phase = "failed";
      journal.last_error = "another source purge became active";
      this.writeJournal(journalPath, journal);
      return { kind: "busy" };
    }

    const nextVersion = row.version + 1;
    this.store.updateWikiStatus(request.service_id, request.wiki_id, {
      status: "pending",
      internal_status: "source-purge/queued",
      sync_error: null,
      version: nextVersion,
    });
    this.audit(row, nextVersion, journal, "accepted");
    this.queue.enqueue(request.wiki_id, () => this.run(journalPath));
    return { kind: "accepted", operation: toPublic(journal) };
  }

  /** Re-enqueue every durable active operation after process restart. */
  recover(): number {
    let recovered = 0;
    const queued = new Set<string>();
    for (const active of findActiveOperationFiles(this.dataRoot)) {
      try {
        const record = readJsonRecord(active);
        const operationId = typeof record.operation_id === "string" ? record.operation_id : "";
        const root = dirname(dirname(active));
        if (!OPERATION_RE.test(operationId)) throw new Error("invalid active operation id");
        const journalPath = this.journalPath(root, operationId);
        if (record.journal !== relative(root, journalPath).replace(/\\/g, "/")) {
          throw new Error("active operation journal path does not match its wiki root");
        }
        const journal = this.readJournal(journalPath);
        if (record.operation_fingerprint !== journal.operation_fingerprint) {
          throw new Error("active operation fingerprint does not match journal");
        }
        if (journal.status === "succeeded" || journal.status === "failed") {
          durableUnlink(active);
          continue;
        }
        this.queue.enqueue(journal.wiki_id, () => this.run(journalPath));
        queued.add(journalPath);
        recovered++;
      } catch (err) {
        this.logger?.error?.(`[wiki-source-purge] recovery refused ${active}: ${String(err)}`);
      }
    }
    // Covers the narrow crash window after durable journal creation and before
    // durable active-operation creation.
    for (const journalPath of findOperationJournalFiles(this.dataRoot)) {
      if (queued.has(journalPath)) continue;
      try {
        const journal = this.readJournal(journalPath);
        if (journal.status === "succeeded" || journal.status === "failed") continue;
        const root = dirname(dirname(dirname(journalPath)));
        const active = activeOperationPath(root);
        if (existsSync(active)) continue;
        if (!createJsonExclusive(active, activeOperationRecord(root, journalPath, journal))) continue;
        this.queue.enqueue(journal.wiki_id, () => this.run(journalPath));
        recovered++;
      } catch (err) {
        this.logger?.error?.(`[wiki-source-purge] orphan journal recovery refused ${journalPath}: ${String(err)}`);
      }
    }
    return recovered;
  }

  async onIdle(wikiId?: string): Promise<void> {
    await this.queue.onIdle(wikiId);
  }

  private async run(journalPath: string): Promise<void> {
    let journal = this.readJournal(journalPath);
    if (journal.status === "succeeded" || journal.status === "failed") return;
    const root = this.wikiService.storageRootFor(journal.service_id, journal.team_id, journal.wiki_id);
    if (resolve(journalPath) !== resolve(this.journalPath(root, journal.operation_id))) {
      throw new Error("source purge journal is not located under its declared wiki root");
    }
    assertSafeSourcePurgeLayout(root);
    const activePath = activeOperationPath(root);
    const generationDir = safeGenerationPath(root, journal.generation_id);
    const stagingDir = `${generationDir}.staging`;

    try {
      const pointer = readActiveGeneration(root);
      if (isPublishedPhase(journal.phase)) {
        assertExactActiveGeneration(pointer, journal);
      } else if (pointer?.operation_id === journal.operation_id) {
        assertExactActiveGeneration(pointer, journal);
        journal = this.advance(journalPath, journal, "generation_published", "running");
      } else if (
        journal.previous_generation_id === null
          ? pointer !== null
          : pointer?.generation_id !== journal.previous_generation_id
      ) {
        throw new Error("active generation changed since source purge acceptance");
      }

      if (!isPublishedPhase(journal.phase)) {
        const currentDir = resolveActiveWikiDir(root);
        const actual = scanRawManifest(currentDir);
        const expected = sortManifest([journal.target, ...journal.remaining_manifest]);
        if (!sameManifest(actual, expected)) {
          throw new Error(`manifest CAS changed after acceptance: ${manifestDigest(actual)}`);
        }

        rmSync(stagingDir, { recursive: true, force: true });
        rmSync(generationDir, { recursive: true, force: true });
        mkdirSync(join(stagingDir, "raw", "sources"), { recursive: true });
        if (statSync(root).dev !== statSync(stagingDir).dev) {
          throw new Error("staging generation is not on the wiki filesystem");
        }

        journal = this.advance(journalPath, journal, "copying_raw", "running");
        copyExactRawManifest(currentDir, stagingDir, journal.remaining_manifest);
        if (!sameManifest(scanRawManifest(stagingDir), journal.remaining_manifest)) {
          throw new Error("staging raw manifest differs after copy");
        }

        journal = this.advance(journalPath, journal, "building", "running");
        const build = await this.worker({
          operationId: journal.operation_id,
          generationId: journal.generation_id,
          wikiId: journal.wiki_id,
          serviceId: journal.service_id,
          teamId: journal.team_id,
          stagingDir,
          remainingManifest: journal.remaining_manifest,
          setInternalStatus: (status) => this.store.updateWikiStatus(journal.service_id, journal.wiki_id, {
            status: "processing",
            internal_status: status,
          }),
        });

        const validation = validateGeneration(
          stagingDir,
          journal.target.filename,
          journal.remaining_manifest,
          journal.residue_markers,
          build.pageCount,
        );
        journal.validation = validation;
        journal = this.advance(journalPath, journal, "validated", "running");
        fsyncTree(stagingDir);
        renameSync(stagingDir, generationDir);
        fsyncDirectory(dirname(generationDir));

        const activatedAt = new Date().toISOString();
        atomicWriteJson(activeGenerationPath(root), {
          schema_version: 1,
          generation_id: journal.generation_id,
          operation_id: journal.operation_id,
          activated_at: activatedAt,
        });
        journal = this.advance(journalPath, journal, "generation_published", "running");
      }

      assertExactActiveGeneration(readActiveGeneration(root), journal);
      if (!journal.validation) throw new Error("pre-publication validation receipt missing");
      journal.validation = validateGeneration(
        generationDir,
        journal.target.filename,
        journal.remaining_manifest,
        journal.residue_markers,
        journal.validation.page_count,
      );
      this.writeJournal(journalPath, journal);
      const activated = this.activateGeneration(journal.wiki_id, generationDir);
      journal.validation = validateGeneration(
        generationDir,
        journal.target.filename,
        journal.remaining_manifest,
        journal.residue_markers,
        activated.pageCount,
      );
      const finalValidation = journal.validation;
      this.writeJournal(journalPath, journal);
      assertExactActiveGeneration(readActiveGeneration(root), journal);
      journal = this.advance(journalPath, journal, "cleaning_retired_generation", "running");
      assertExactActiveGeneration(readActiveGeneration(root), journal);
      this.retireGeneration(root, journal.previous_generation_id, journal.generation_id);
      assertExactActiveGeneration(readActiveGeneration(root), journal);

      const completedAt = new Date().toISOString();
      const activePointer = readActiveGeneration(root);
      assertExactActiveGeneration(activePointer, journal);
      const receipt: SourcePurgeReceipt = {
        schema_version: 1,
        operation_id: journal.operation_id,
        operation_fingerprint: journal.operation_fingerprint,
        wiki_id: journal.wiki_id,
        team_id: journal.team_id,
        deleted_source: journal.target,
        remaining_manifest_sha256: journal.remaining_manifest_sha256,
        remaining_source_count: journal.remaining_manifest.length,
        generation_id: journal.generation_id,
        ...finalValidation,
        activated_at: activePointer.activated_at,
        completed_at: completedAt,
      };
      const current = this.store.getWiki(journal.service_id, journal.team_id, journal.wiki_id);
      this.store.updateWikiStatus(journal.service_id, journal.wiki_id, {
        status: "ready",
        internal_status: null,
        sync_error: null,
        page_count: receipt.page_count,
        summary: null,
        last_sync_at: completedAt,
      });
      const committed = this.store.getWiki(journal.service_id, journal.team_id, journal.wiki_id);
      if (!committed || committed.status !== "ready" || committed.summary !== null || committed.page_count !== receipt.page_count) {
        throw new Error("metadata readback did not confirm ready state and cleared summary");
      }
      if (current) this.audit(current, current.version, journal, "completed");
      journal = {
        ...journal,
        residue_markers: [],
        previous_metadata: { ...journal.previous_metadata, summary: null },
        receipt,
        status: "succeeded",
        phase: "succeeded",
        updated_at: completedAt,
        redacted_at: completedAt,
        last_error: null,
      };
      this.writeJournal(journalPath, journal);
      try {
        durableUnlink(activePath);
      } catch (err) {
        this.logger?.error?.(`[wiki-source-purge] ${journal.operation_id} terminal cleanup deferred: ${String(err)}`);
      }
      this.logger?.info?.(`[wiki-source-purge] ${journal.operation_id} succeeded`);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      let durable = journal;
      try { durable = this.readJournal(journalPath); } catch { /* preserve the last in-memory state */ }
      if (durable.status === "succeeded" && durable.receipt) {
        try { durableUnlink(activePath); } catch { /* startup recovery will retry */ }
        this.logger?.error?.(`[wiki-source-purge] ${durable.operation_id} succeeded with deferred cleanup: ${message}`);
        return;
      }

      let pointer = null;
      let pointerUnreadable = false;
      try { pointer = readActiveGeneration(root); } catch { pointerUnreadable = true; }
      const pointerMatchesCurrent = pointer?.operation_id === durable.operation_id &&
        pointer.generation_id === durable.generation_id;
      const pointerMatchesPrevious = durable.previous_generation_id === null
        ? pointer === null
        : pointer?.generation_id === durable.previous_generation_id;
      if (isPublishedPhase(durable.phase) || pointerMatchesCurrent || pointerUnreadable || !pointerMatchesPrevious) {
        journal = {
          ...durable,
          // Never move a durable CLEANING operation backwards. Recovery may
          // safely repeat retirement, but it must not re-enter publication
          // logic with an already-partially-removed rollback generation.
          phase: isPublishedPhase(durable.phase)
            ? durable.phase
            : pointerMatchesCurrent ? "generation_published" : durable.phase,
          status: "running",
          last_error: message,
          updated_at: new Date().toISOString(),
        };
        this.writeJournal(journalPath, journal);
        this.store.updateWikiStatus(journal.service_id, journal.wiki_id, {
          status: "processing",
          internal_status: "source-purge/recovery-required",
          sync_error: message,
        });
        this.logger?.error?.(`[wiki-source-purge] ${journal.operation_id} needs recovery: ${message}`);
        return;
      }

      rmSync(stagingDir, { recursive: true, force: true });
      if (existsSync(generationDir)) rmSync(generationDir, { recursive: true, force: true });
      journal = {
        ...durable,
        phase: "failed",
        status: "failed",
        last_error: message,
        updated_at: new Date().toISOString(),
      };
      this.writeJournal(journalPath, journal);
      this.store.updateWikiStatus(journal.service_id, journal.wiki_id, {
        status: journal.previous_metadata.status,
        internal_status: journal.previous_metadata.internal_status,
        sync_error: journal.previous_metadata.sync_error,
        page_count: journal.previous_metadata.page_count,
        summary: journal.previous_metadata.summary,
        last_sync_at: journal.previous_metadata.last_sync_at,
      });
      const row = this.store.getWiki(journal.service_id, journal.team_id, journal.wiki_id);
      if (row) this.audit(row, row.version, journal, `failed:${message}`);
      durableUnlink(activePath);
      this.logger?.error?.(`[wiki-source-purge] ${journal.operation_id} failed: ${message}`);
    }
  }

  private advance(
    path: string,
    journal: SourcePurgeJournal,
    phase: JournalPhase,
    status: SourcePurgeJournal["status"],
  ): SourcePurgeJournal {
    const next = { ...journal, phase, status, updated_at: new Date().toISOString(), last_error: null };
    this.writeJournal(path, next);
    return next;
  }

  private journalPath(root: string, operationId: string): string {
    return join(sourcePurgeOperationsDir(root), `${operationId}.json`);
  }

  private readJournal(path: string): SourcePurgeJournal {
    const value = readJsonRecord(path) as Partial<SourcePurgeJournal>;
    const fail = (reason: string): never => { throw new Error(`invalid source purge journal (${reason}): ${path}`); };
    if (value.schema_version !== 1) fail("schema_version");
    if (typeof value.operation_id !== "string" || !OPERATION_RE.test(value.operation_id)) fail("operation_id");
    if (basename(path) !== `${value.operation_id}.json`) fail("path/operation mismatch");
    if (typeof value.operation_fingerprint !== "string" || !SHA256_RE.test(value.operation_fingerprint)) fail("fingerprint");
    if (typeof value.service_id !== "string" || !ID_RE.test(value.service_id)) fail("service_id");
    if (typeof value.team_id !== "string" || !ID_RE.test(value.team_id)) fail("team_id");
    if (typeof value.wiki_id !== "string" || !ID_RE.test(value.wiki_id)) fail("wiki_id");
    if (!isJournalStatus(value.status) || !isJournalPhase(value.phase)) fail("status/phase");
    if (
      !value.target ||
      !Array.isArray(value.remaining_manifest) ||
      !Array.isArray(value.residue_markers) ||
      !Array.isArray(value.residue_marker_sha256)
    ) fail("request fields");
    const operationId = value.operation_id as string;
    const operationFingerprintValue = value.operation_fingerprint as string;
    const serviceId = value.service_id as string;
    const teamId = value.team_id as string;
    const wikiId = value.wiki_id as string;
    const status = value.status as SourcePurgeJournal["status"];
    const phase = value.phase as JournalPhase;
    const target = value.target as SourceManifestEntry;
    const remainingManifest = value.remaining_manifest as SourceManifestEntry[];
    const residueMarkers = value.residue_markers as string[];
    const residueMarkerSha256 = value.residue_marker_sha256 as string[];
    const expectedRoot = this.wikiService.storageRootFor(serviceId, teamId, wikiId);
    if (resolve(path) !== resolve(this.journalPath(expectedRoot, operationId))) fail("tenant path binding");
    const manifestError = validateManifestSet(target, remainingManifest);
    if (manifestError) fail(`request: ${manifestError}`);
    if (
      residueMarkerSha256.length < 1 ||
      residueMarkerSha256.length > MAX_MARKERS ||
      residueMarkerSha256.some((digest) => !SHA256_RE.test(digest)) ||
      new Set(residueMarkerSha256).size !== residueMarkerSha256.length
    ) fail("marker digests");
    if (value.previous_summary_sha256 !== null && (
      typeof value.previous_summary_sha256 !== "string" ||
      !SHA256_RE.test(value.previous_summary_sha256)
    )) fail("previous summary digest");
    if (status === "succeeded") {
      if (residueMarkers.length !== 0) fail("terminal marker redaction");
      if (typeof value.redacted_at !== "string") fail("terminal redaction timestamp");
    } else {
      const request: SourcePurgeRequest = {
        operation_id: operationId,
        service_id: serviceId,
        team_id: teamId,
        wiki_id: wikiId,
        target,
        remaining_manifest: remainingManifest,
        residue_markers: residueMarkers,
      };
      const invalid = validateRequest(request);
      if (invalid) fail(`request: ${invalid}`);
      if (operationFingerprint(request) !== operationFingerprintValue) fail("fingerprint mismatch");
      if (JSON.stringify(markerDigests(residueMarkers)) !== JSON.stringify(residueMarkerSha256)) {
        fail("marker digest mismatch");
      }
      if (value.redacted_at !== undefined) fail("premature redaction timestamp");
    }
    if (value.remaining_manifest_sha256 !== manifestDigest(remainingManifest)) fail("manifest digest");
    const expectedGeneration = `gen_${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;
    if (value.generation_id !== expectedGeneration || !GENERATION_RE.test(value.generation_id)) fail("generation_id");
    if (value.previous_generation_id !== null && (
      typeof value.previous_generation_id !== "string" || !GENERATION_RE.test(value.previous_generation_id)
    )) fail("previous_generation_id");
    if (!value.previous_metadata || !isPreviousMetadata(value.previous_metadata)) fail("previous_metadata");
    const previousMetadata = value.previous_metadata as SourcePurgeJournal["previous_metadata"];
    if (status === "succeeded" && previousMetadata.summary !== null) fail("terminal summary redaction");
    if (status !== "succeeded") {
      const expectedSummaryDigest = previousMetadata.summary === null
        ? null
        : createHash("sha256").update(previousMetadata.summary).digest("hex");
      if (value.previous_summary_sha256 !== expectedSummaryDigest) fail("previous summary digest mismatch");
    }
    if (value.requester_user_id !== null && typeof value.requester_user_id !== "string") fail("requester_user_id");
    if (typeof value.created_at !== "string" || typeof value.updated_at !== "string") fail("timestamps");
    if (value.last_error !== null && typeof value.last_error !== "string") fail("last_error");
    if (value.validation !== undefined && !isValidation(value.validation, residueMarkerSha256, remainingManifest.length)) fail("validation");
    if (value.receipt !== undefined && !isReceipt(value.receipt, value)) fail("receipt");
    if (status === "succeeded" && (phase !== "succeeded" || value.receipt === undefined)) fail("succeeded terminal state");
    if (status === "failed" && phase !== "failed") fail("failed terminal state");
    if ((phase === "generation_published" || phase === "cleaning_retired_generation" || phase === "succeeded") && value.validation === undefined) {
      fail("published state without validation");
    }
    if (status !== "succeeded" && value.receipt !== undefined) fail("nonterminal receipt");
    return value as SourcePurgeJournal;
  }

  private writeJournal(path: string, journal: SourcePurgeJournal): void {
    atomicWriteJson(path, journal);
  }

  private audit(
    row: WikiRow,
    version: number,
    journal: SourcePurgeJournal,
    event: string,
  ): void {
    this.store.appendWikiAudit({
      service_id: row.service_id,
      asset_id: row.wiki_id,
      version,
      action: "source_purge_rebuild",
      user_id: journal.requester_user_id ?? row.user_id,
      agent_id: row.agent_id,
      detail: JSON.stringify({
        event,
        operation_id: journal.operation_id,
        operation_fingerprint: journal.operation_fingerprint,
        target_filename: journal.target.filename,
        target_sha256: journal.target.sha256,
        remaining_manifest_sha256: journal.remaining_manifest_sha256,
      }),
    });
  }
}

function validateRequest(request: SourcePurgeRequest): string | null {
  if (!OPERATION_RE.test(request.operation_id)) return "operation_id must be 16-128 characters [A-Za-z0-9_-]";
  if (!ID_RE.test(request.service_id) || !ID_RE.test(request.team_id) || !ID_RE.test(request.wiki_id)) {
    return "service_id, team_id and wiki_id must be safe path segments";
  }
  const manifestError = validateManifestSet(request.target, request.remaining_manifest);
  if (manifestError) return manifestError;
  if (
    !Array.isArray(request.residue_markers) ||
    request.residue_markers.length === 0 ||
    request.residue_markers.length > MAX_MARKERS ||
    new Set(request.residue_markers).size !== request.residue_markers.length
  ) {
    return `residue_markers must contain 1-${MAX_MARKERS} unique strings`;
  }
  for (const marker of request.residue_markers) {
    const bytes = typeof marker === "string" ? Buffer.byteLength(marker, "utf-8") : 0;
    if (bytes < 8 || bytes > MAX_MARKER_BYTES) return `each residue marker must be 8-${MAX_MARKER_BYTES} bytes`;
  }
  return null;
}

function validateManifestSet(target: SourceManifestEntry, remaining: SourceManifestEntry[]): string | null {
  const targetError = validateManifestEntry(target);
  if (targetError) return `target ${targetError}`;
  if (!Array.isArray(remaining) || remaining.length > MAX_SOURCES) {
    return `remaining_manifest must contain at most ${MAX_SOURCES} entries`;
  }
  const names = new Set<string>();
  const targetBase = basename(target.filename);
  for (const entry of remaining) {
    const error = validateManifestEntry(entry);
    if (error) return `remaining_manifest ${error}`;
    if (names.has(entry.filename)) return `duplicate remaining filename: ${entry.filename}`;
    if (basename(entry.filename) === targetBase) return "target basename collides with a remaining source";
    names.add(entry.filename);
  }
  if (names.has(target.filename)) return "target must not appear in remaining_manifest";
  return null;
}

function validateManifestEntry(entry: SourceManifestEntry): string | null {
  if (!entry || typeof entry !== "object") return "entry must be an object";
  if (!isSafeRelativePath(entry.filename)) return `has invalid filename: ${String(entry.filename)}`;
  if (!SHA256_RE.test(entry.sha256)) return `has invalid sha256 for ${entry.filename}`;
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) return `has invalid size for ${entry.filename}`;
  return null;
}

function isSafeRelativePath(path: string): boolean {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && part.length <= 255);
}

function canonicalRequest(request: SourcePurgeRequest): object {
  return {
    schema_version: 1,
    operation_id: request.operation_id,
    service_id: request.service_id,
    team_id: request.team_id,
    wiki_id: request.wiki_id,
    target: canonicalManifestEntry(request.target),
    remaining_manifest: sortManifest(request.remaining_manifest),
    residue_markers: [...request.residue_markers].sort(),
  };
}

function operationFingerprint(request: SourcePurgeRequest): string {
  return createHash("sha256").update(JSON.stringify(canonicalRequest(request))).digest("hex");
}

function manifestDigest(manifest: SourceManifestEntry[]): string {
  return createHash("sha256").update(JSON.stringify(sortManifest(manifest))).digest("hex");
}

function sortManifest(manifest: SourceManifestEntry[]): SourceManifestEntry[] {
  return manifest
    .map(canonicalManifestEntry)
    .sort((a, b) => Buffer.compare(Buffer.from(a.filename, "utf-8"), Buffer.from(b.filename, "utf-8")));
}

function canonicalManifestEntry(entry: SourceManifestEntry): SourceManifestEntry {
  return { filename: entry.filename, sha256: entry.sha256, size: entry.size };
}

function sameManifest(a: SourceManifestEntry[], b: SourceManifestEntry[]): boolean {
  return JSON.stringify(sortManifest(a)) === JSON.stringify(sortManifest(b));
}

export function scanRawManifest(projectDir: string): SourceManifestEntry[] {
  const rawRoot = join(projectDir, "raw", "sources");
  if (!existsSync(rawRoot)) return [];
  const files: SourceManifestEntry[] = [];
  let total = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`raw source symlink refused: ${full}`);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) throw new Error(`raw source is not a regular file: ${full}`);
      const rel = relative(rawRoot, full).replace(/\\/g, "/");
      if (!isSafeRelativePath(rel)) throw new Error(`invalid raw source path: ${rel}`);
      const stat = lstatSync(full);
      total += stat.size;
      if (files.length >= MAX_SOURCES || total > MAX_TOTAL_SOURCE_BYTES) {
        throw new Error("raw source manifest exceeds purge limits");
      }
      const bytes = readFileSync(full);
      files.push({ filename: rel, sha256: createHash("sha256").update(bytes).digest("hex"), size: stat.size });
    }
  };
  walk(rawRoot);
  return sortManifest(files);
}

function copyExactRawManifest(
  currentDir: string,
  stagingDir: string,
  manifest: SourceManifestEntry[],
): void {
  const sourceRoot = resolve(currentDir, "raw", "sources");
  const targetRoot = resolve(stagingDir, "raw", "sources");
  for (const entry of manifest) {
    const source = resolve(sourceRoot, entry.filename);
    const target = resolve(targetRoot, entry.filename);
    if (!source.startsWith(`${sourceRoot}/`) || !target.startsWith(`${targetRoot}/`)) {
      throw new Error(`manifest path escaped raw root: ${entry.filename}`);
    }
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`raw source is not regular: ${entry.filename}`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
  }
}

function validateMarkerPlacement(
  currentDir: string,
  target: SourceManifestEntry,
  remaining: SourceManifestEntry[],
  markers: string[],
): string | null {
  const rawRoot = resolve(currentDir, "raw", "sources");
  const targetText = readFileSync(resolve(rawRoot, target.filename), "utf-8").toLowerCase();
  const remainingText = remaining
    .map((entry) => readFileSync(resolve(rawRoot, entry.filename), "utf-8").toLowerCase())
    .join("\n");
  for (const marker of markers) {
    const lower = marker.toLowerCase();
    if (!targetText.includes(lower)) return "each residue marker must occur in the target source";
    if (remainingText.includes(lower)) return "a residue marker also occurs in a remaining source";
  }
  return null;
}

function validateGeneration(
  generationDir: string,
  targetFilename: string,
  remaining: SourceManifestEntry[],
  markers: string[],
  reportedPageCount: number,
): SourcePurgeJournal["validation"] & object {
  const raw = scanRawManifest(generationDir);
  if (!sameManifest(raw, remaining)) throw new Error("validation: raw manifest mismatch");

  const pages = scanPageFiles(generationDir);
  if (pages.length !== reportedPageCount) {
    throw new Error(`validation: page count mismatch ${pages.length} != ${reportedPageCount}`);
  }
  const targetBase = basename(targetFilename);
  const loweredMarkers = markers.map((marker) => marker.toLowerCase());
  for (const page of pages) {
    const sources = readSources(page.content);
    if (sources.some((source) => source === targetFilename || source === targetBase)) {
      throw new Error(`validation: target source remains in page ${page.path}`);
    }
    const lower = page.content.toLowerCase();
    if (loweredMarkers.some((marker) => lower.includes(marker))) {
      throw new Error(`validation: residue marker remains in page ${page.path}`);
    }
  }

  const dbResult = withWriteDb(generationDir, (db) => {
    const sources = listSources(db);
    const expected = sortManifest(remaining);
    const actual = sources.map((source) => ({ filename: source.filename, sha256: source.sha256, size: source.size }));
    if (!sameManifest(actual, expected)) throw new Error("validation: source table mismatch");
    if (sources.some((source) => source.status !== "ingested" || source.ingest_error !== null)) {
      throw new Error("validation: a remaining source is not cleanly ingested");
    }
    const fts = db.prepare("SELECT page_id, title_tok, content_tok FROM wiki_fts ORDER BY page_id").all() as Array<{
      page_id: string; title_tok: string; content_tok: string;
    }>;
    const metaIds = new Set((db.prepare("SELECT page_id FROM page_meta").all() as Array<{ page_id: string }>).map((r) => r.page_id));
    if (fts.length !== metaIds.size || fts.some((row) => !metaIds.has(row.page_id))) {
      throw new Error("validation: FTS/page_meta mismatch");
    }
    for (const marker of markers) {
      const needle = tokenize(marker).join(" ");
      if (needle && fts.some((row) => `${row.title_tok} ${row.content_tok}`.includes(needle))) {
        throw new Error("validation: residue marker remains in FTS");
      }
    }
    const edges = db.prepare("SELECT source_id, target_id FROM graph_edge").all() as Array<{
      source_id: string; target_id: string;
    }>;
    if (edges.some((edge) => !metaIds.has(edge.source_id) || !metaIds.has(edge.target_id))) {
      throw new Error("validation: graph contains an orphan endpoint");
    }
    return { sourceRows: sources.length, ftsRows: fts.length, graphEdges: edges.length };
  });

  return {
    page_count: pages.length,
    source_row_count: dbResult.sourceRows,
    fts_row_count: dbResult.ftsRows,
    graph_edge_count: dbResult.graphEdges,
    residue_marker_sha256: markerDigests(markers),
    residue_matches: 0,
    summary_cleared: true,
  };
}

function scanPageFiles(projectDir: string): Array<{ path: string; content: string }> {
  const root = join(projectDir, "wiki");
  if (!existsSync(root)) return [];
  const out: Array<{ path: string; content: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`wiki page symlink refused: ${full}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push({ path: relative(root, full).replace(/\\/g, "/"), content: readFileSync(full, "utf-8") });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf-8"), Buffer.from(b.path, "utf-8")));
}

function cleanupRetiredGeneration(root: string, previousGenerationId: string | null, activeGenerationId: string): void {
  const activeDir = safeGenerationPath(root, activeGenerationId);
  const activeStat = lstatSync(activeDir);
  if (!activeStat.isDirectory() || activeStat.isSymbolicLink()) {
    throw new Error("active generation must remain a real directory during cleanup");
  }
  if (previousGenerationId === activeGenerationId) {
    throw new Error("retired generation must differ from the active generation");
  }

  if (previousGenerationId) {
    const retiredDir = safeGenerationPath(root, previousGenerationId);
    if (existsSync(retiredDir)) {
      const retiredStat = lstatSync(retiredDir);
      if (!retiredStat.isDirectory() || retiredStat.isSymbolicLink()) {
        throw new Error("retired generation must be a real directory");
      }
      rmSync(retiredDir, { recursive: true, force: true });
    }
  } else {
    for (const rel of ["raw", "wiki", ".llm-wiki", "index.db", "index.db-wal", "index.db-shm"]) {
      rmSync(join(root, rel), { recursive: true, force: true });
    }
  }
  const survivingActive = lstatSync(activeDir);
  if (!survivingActive.isDirectory() || survivingActive.isSymbolicLink()) {
    throw new Error("active generation was lost while cleaning the retired generation");
  }
  fsyncDirectory(root);
}

function safeGenerationPath(root: string, generationId: string): string {
  if (!GENERATION_RE.test(generationId)) throw new Error(`invalid generation id: ${generationId}`);
  const generations = resolve(sourcePurgeGenerationsDir(root));
  const path = resolve(generations, generationId);
  if (!path.startsWith(`${generations}/`)) throw new Error("generation path escaped control directory");
  return path;
}

function fsyncTree(root: string): void {
  const walk = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`generation symlink refused during fsync: ${path}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
      fsyncDirectory(path);
      return;
    }
    if (!stat.isFile()) throw new Error(`generation special file refused during fsync: ${path}`);
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  walk(root);
}

function isPublishedPhase(phase: JournalPhase): boolean {
  return phase === "generation_published" || phase === "cleaning_retired_generation" || phase === "succeeded";
}

function assertExactActiveGeneration(
  pointer: ReturnType<typeof readActiveGeneration>,
  journal: SourcePurgeJournal,
): asserts pointer is NonNullable<ReturnType<typeof readActiveGeneration>> {
  if (
    pointer === null ||
    pointer.operation_id !== journal.operation_id ||
    pointer.generation_id !== journal.generation_id
  ) {
    throw new Error("active generation pointer does not match the durable purge operation");
  }
}

function readJsonRecord(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`regular JSON file required: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`JSON object required: ${path}`);
  return parsed as Record<string, unknown>;
}

function isJournalStatus(value: unknown): value is SourcePurgeJournal["status"] {
  return value === "pending" || value === "running" || value === "succeeded" || value === "failed";
}

function isJournalPhase(value: unknown): value is JournalPhase {
  return value === "accepted" || value === "copying_raw" || value === "building" || value === "validated" ||
    value === "generation_published" || value === "cleaning_retired_generation" || value === "succeeded" || value === "failed";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isPreviousMetadata(value: unknown): value is SourcePurgeJournal["previous_metadata"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  const validStatus = meta.status === "draft" || meta.status === "pending" || meta.status === "processing" ||
    meta.status === "ready" || meta.status === "failed";
  return validStatus &&
    isNullableString(meta.internal_status) &&
    isNullableString(meta.sync_error) &&
    (meta.page_count === null || (Number.isSafeInteger(meta.page_count) && (meta.page_count as number) >= 0)) &&
    isNullableString(meta.summary) &&
    isNullableString(meta.last_sync_at);
}

function isValidation(
  value: unknown,
  expectedMarkerDigests: string[],
  remainingCount: number,
): value is NonNullable<SourcePurgeJournal["validation"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const validation = value as Record<string, unknown>;
  const counts = [validation.page_count, validation.source_row_count, validation.fts_row_count, validation.graph_edge_count];
  return counts.every((count) => Number.isSafeInteger(count) && (count as number) >= 0) &&
    validation.page_count === validation.fts_row_count &&
    validation.source_row_count === remainingCount &&
    Array.isArray(validation.residue_marker_sha256) &&
    JSON.stringify(validation.residue_marker_sha256) === JSON.stringify(expectedMarkerDigests) &&
    validation.residue_matches === 0 &&
    validation.summary_cleared === true;
}

function isReceipt(value: unknown, journal: Partial<SourcePurgeJournal>): value is SourcePurgeReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const target = journal.target as SourceManifestEntry | undefined;
  const receiptTarget = receipt.deleted_source as SourceManifestEntry | undefined;
  return receipt.schema_version === 1 &&
    receipt.operation_id === journal.operation_id &&
    receipt.operation_fingerprint === journal.operation_fingerprint &&
    receipt.wiki_id === journal.wiki_id &&
    receipt.team_id === journal.team_id &&
    !!target && !!receiptTarget && validateManifestEntry(receiptTarget) === null &&
    JSON.stringify(canonicalManifestEntry(receiptTarget)) === JSON.stringify(canonicalManifestEntry(target)) &&
    receipt.remaining_manifest_sha256 === journal.remaining_manifest_sha256 &&
    receipt.remaining_source_count === journal.remaining_manifest?.length &&
    receipt.generation_id === journal.generation_id &&
    typeof receipt.activated_at === "string" &&
    typeof receipt.completed_at === "string" &&
    isValidation(receipt, journal.residue_marker_sha256 ?? [], journal.remaining_manifest?.length ?? -1);
}

function markerDigests(markers: string[]): string[] {
  return markers.map((marker) => createHash("sha256").update(marker).digest("hex"));
}

function toPublic(journal: SourcePurgeJournal): PublicSourcePurgeOperation {
  return {
    operation_id: journal.operation_id,
    operation_fingerprint: journal.operation_fingerprint,
    status: journal.status,
    phase: journal.phase,
    receipt: journal.receipt ?? null,
    error: journal.last_error,
  };
}

function activeOperationRecord(root: string, journalPath: string, journal: SourcePurgeJournal): object {
  return {
    schema_version: 1,
    operation_id: journal.operation_id,
    operation_fingerprint: journal.operation_fingerprint,
    journal: relative(root, journalPath).replace(/\\/g, "/"),
    created_at: journal.created_at,
  };
}

function findActiveOperationFiles(dataRoot: string): string[] {
  if (!existsSync(dataRoot)) return [];
  const found: string[] = [];
  for (const service of safeDirectories(dataRoot)) {
    for (const team of safeDirectories(join(dataRoot, service))) {
      for (const wiki of safeDirectories(join(dataRoot, service, team))) {
        const path = activeOperationPath(join(dataRoot, service, team, wiki));
        if (existsSync(path)) found.push(path);
      }
    }
  }
  return found;
}

function findOperationJournalFiles(dataRoot: string): string[] {
  if (!existsSync(dataRoot)) return [];
  const found: string[] = [];
  for (const service of safeDirectories(dataRoot)) {
    for (const team of safeDirectories(join(dataRoot, service))) {
      for (const wiki of safeDirectories(join(dataRoot, service, team))) {
        const dir = sourcePurgeOperationsDir(join(dataRoot, service, team, wiki));
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".json")) found.push(join(dir, entry.name));
        }
      }
    }
  }
  return found;
}

function safeDirectories(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => /^[A-Za-z0-9_-]{1,200}$/.test(name));
}
