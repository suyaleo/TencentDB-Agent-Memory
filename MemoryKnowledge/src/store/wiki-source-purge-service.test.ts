import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDb } from "../db/client.js";
import { initIndexDb, recordSourceIngestResult, withWriteDb } from "../engines/wiki/index-db.js";
import { createWikiSourceManager, tokenize } from "../engines/wiki/manager.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
import { WikiService } from "./wiki-service.js";
import {
  activeGenerationPath,
  activeOperationPath,
  sourcePurgeGenerationsDir,
  sourcePurgeOperationsDir,
} from "./wiki-generation.js";
import {
  WikiSourcePurgeService,
  scanRawManifest,
  type SourceManifestEntry,
  type SourcePurgeBuildContext,
  type SourcePurgeRequest,
} from "./wiki-source-purge-service.js";

const SERVICE_ID = "service-1";
const TEAM_ID = "team-1";
const MARKER = "PURGE-MARKER-ONLY-IN-TARGET-7f9b3c";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deterministicWorker() {
  return vi.fn(async (ctx: SourcePurgeBuildContext) => {
    mkdirSync(join(ctx.stagingDir, "wiki"), { recursive: true });
    initIndexDb(ctx.stagingDir);
    const pages = ctx.remainingManifest.map((source, index) => {
      const id = `concepts/remaining-${index + 1}`;
      const content = [
        "---",
        "type: concept",
        `title: Remaining ${index + 1}`,
        "sources:",
        `  - ${basename(source.filename)}`,
        "---",
        "",
        `# Remaining ${index + 1}`,
        "",
        "Clean rebuilt knowledge.",
        "",
      ].join("\n");
      const path = join(ctx.stagingDir, "wiki", `${id}.md`);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content, "utf-8");
      return { id, content, source };
    });

    withWriteDb(ctx.stagingDir, (db) => {
      for (const page of pages) {
        recordSourceIngestResult(db, { ...page.source, ok: true });
        db.prepare("INSERT INTO page_meta(page_id,title,type,rel_path,snippet) VALUES (?,?,?,?,?)")
          .run(page.id, page.id, "concept", `wiki/${page.id}.md`, "Clean rebuilt knowledge.");
        db.prepare("INSERT INTO wiki_fts(page_id,title_tok,content_tok) VALUES (?,?,?)")
          .run(page.id, tokenize(page.id).join(" "), tokenize(page.content).join(" "));
      }
    });
    return { pageCount: pages.length };
  });
}

function emptyGenerationWorker() {
  return vi.fn(async (ctx: SourcePurgeBuildContext) => {
    const stateDir = join(ctx.stagingDir, ".empty-worker-state");
    const manager = createWikiSourceManager(stateDir);
    const name = `${ctx.wikiId}_${ctx.generationId}`;
    try {
      manager.init({ name, path: ctx.stagingDir });
      return { pageCount: manager.getPages(name).length };
    } finally {
      manager.remove(name);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

function countMarkdownFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) count += countMarkdownFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".md")) count++;
  }
  return count;
}

function activationSnapshot(_wikiId: string, generationDir: string) {
  return { pageCount: countMarkdownFiles(join(generationDir, "wiki")) };
}

function fixture(targetOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "wiki-source-purge-test-"));
  roots.push(root);
  const { db, raw } = createDb({ path: join(root, "metadata.sqlite3") });
  const store = new SqliteKnowledgeStore(db);
  const wikiService = new WikiService({
    store,
    dataRoot: join(root, "data"),
    worker: async () => ({ pageCount: 0 }),
  });
  const { row } = wikiService.create({
    service_id: SERVICE_ID,
    team_id: TEAM_ID,
    name: "purge-test",
    owner_user_id: "owner-1",
    user_id: "owner-1",
  });
  const files = [
    { filename: "target.md", content: `target body ${MARKER}` },
    ...(!targetOnly ? [{ filename: "remaining.md", content: "remaining body safe phrase" }] : []),
  ];
  expect(wikiService.rawWriteMany(SERVICE_ID, TEAM_ID, row.wiki_id, files, "owner-1")).toBeTruthy();
  const legacyWiki = join(wikiService.dirFor(SERVICE_ID, TEAM_ID, row.wiki_id), "wiki");
  mkdirSync(join(legacyWiki, "concepts"), { recursive: true });
  writeFileSync(join(legacyWiki, "concepts", "stale.md"), `stale ${MARKER}`, "utf-8");
  store.updateWikiStatus(SERVICE_ID, row.wiki_id, { status: "ready", summary: `old ${MARKER}` });

  const manifest = scanRawManifest(wikiService.dirFor(SERVICE_ID, TEAM_ID, row.wiki_id));
  const target = manifest.find((entry) => entry.filename === "target.md")!;
  const remaining = manifest.filter((entry) => entry.filename !== "target.md");
  const request: SourcePurgeRequest = {
    operation_id: "purge_operation_0001",
    service_id: SERVICE_ID,
    team_id: TEAM_ID,
    wiki_id: row.wiki_id,
    target,
    remaining_manifest: remaining,
    residue_markers: [MARKER],
    requester_user_id: "owner-1",
  };
  return { root, raw, store, wikiService, row, request, remaining };
}

describe("WikiSourcePurgeService", () => {
  it("fences writes, rebuilds only the exact remaining raw generation and returns an idempotent receipt", async () => {
    const f = fixture();
    const worker = deterministicWorker();
    const activate = vi.fn(activationSnapshot);
    const service = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker,
      activateGeneration: activate,
    });

    const accepted = service.submit(f.request);
    expect(accepted.kind).toBe("accepted");
    expect(f.wikiService.rawWrite(SERVICE_ID, TEAM_ID, f.row.wiki_id, "late.md", "blocked"))
      .toBe("operation_active");
    await service.onIdle(f.row.wiki_id);

    const activeDir = f.wikiService.dirFor(SERVICE_ID, TEAM_ID, f.row.wiki_id);
    expect(scanRawManifest(activeDir)).toEqual(f.remaining);
    expect(readFileSync(join(activeDir, "raw", "sources", "remaining.md"), "utf-8"))
      .toBe("remaining body safe phrase");
    expect(() => readFileSync(join(activeDir, "wiki", "concepts", "stale.md"), "utf-8")).toThrow();
    expect(worker).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();

    const retry = service.submit(f.request);
    expect(retry.kind).toBe("existing");
    if (retry.kind !== "existing") throw new Error("unexpected result");
    expect(retry.operation.status).toBe("succeeded");
    expect(retry.operation.receipt).toMatchObject({
      operation_id: f.request.operation_id,
      deleted_source: f.request.target,
      remaining_source_count: 1,
      source_row_count: 1,
      page_count: 1,
      residue_matches: 0,
      summary_cleared: true,
    });
    expect(f.store.getWiki(SERVICE_ID, TEAM_ID, f.row.wiki_id)).toMatchObject({
      status: "ready",
      summary: null,
      page_count: 1,
    });
    expect(f.store.listWikiAudit(SERVICE_ID, f.row.wiki_id).filter((a) => a.action === "source_purge_rebuild"))
      .toHaveLength(2);
    const journalPath = join(
      sourcePurgeOperationsDir(f.wikiService.storageRootFor(SERVICE_ID, TEAM_ID, f.row.wiki_id)),
      `${f.request.operation_id}.json`,
    );
    const terminalJournal = readFileSync(journalPath, "utf-8");
    expect(terminalJournal).not.toContain(MARKER);
    expect(terminalJournal).not.toContain(`old ${MARKER}`);
    expect(JSON.parse(terminalJournal)).toMatchObject({
      residue_markers: [],
      residue_marker_sha256: [createHash("sha256").update(MARKER).digest("hex")],
      previous_summary_sha256: createHash("sha256").update(`old ${MARKER}`).digest("hex"),
      operation_fingerprint: retry.operation.operation_fingerprint,
      previous_metadata: { summary: null },
      redacted_at: expect.any(String),
    });

    const terminal = JSON.parse(terminalJournal) as Record<string, unknown>;
    const activePath = activeOperationPath(
      f.wikiService.storageRootFor(SERVICE_ID, TEAM_ID, f.row.wiki_id),
    );
    writeFileSync(activePath, `${JSON.stringify({
      schema_version: 1,
      operation_id: f.request.operation_id,
      operation_fingerprint: terminal.operation_fingerprint,
      journal: `.source-purge/operations/${f.request.operation_id}.json`,
      created_at: terminal.created_at,
    })}\n`, "utf-8");
    expect(service.recover()).toBe(0);
    expect(existsSync(activePath)).toBe(false);

    const conflict = service.submit({ ...f.request, residue_markers: [`${MARKER}-different`] });
    expect(conflict.kind).toBe("operation_conflict");
    f.raw.close();
  });

  it("publishes a safe empty generation when the target was the final source", async () => {
    const f = fixture(true);
    const worker = emptyGenerationWorker();
    const liveManager = createWikiSourceManager(join(f.root, "live-manager-state"));
    liveManager.init({
      name: f.row.wiki_id,
      path: f.wikiService.dirFor(SERVICE_ID, TEAM_ID, f.row.wiki_id),
    });
    const service = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker,
      activateGeneration: (wikiId, generationDir) => {
        const state = liveManager.activate({ name: wikiId, path: generationDir });
        return { pageCount: state.pageCount ?? liveManager.getPages(wikiId).length };
      },
    });

    expect(service.submit(f.request).kind).toBe("accepted");
    await service.onIdle(f.row.wiki_id);
    const result = service.submit(f.request);
    expect(result.kind).toBe("existing");
    if (result.kind !== "existing") throw new Error("unexpected result");
    expect(result.operation.receipt).toMatchObject({
      remaining_source_count: 0,
      source_row_count: 0,
      page_count: 3,
      fts_row_count: 3,
      graph_edge_count: 0,
    });
    expect(scanRawManifest(f.wikiService.dirFor(SERVICE_ID, TEAM_ID, f.row.wiki_id))).toEqual([]);
    f.raw.close();
  });

  it("runs a second source purge from the generation published by the first operation", async () => {
    const f = fixture();
    const worker = vi.fn(async (ctx: SourcePurgeBuildContext) =>
      ctx.remainingManifest.length === 0
        ? emptyGenerationWorker()(ctx)
        : deterministicWorker()(ctx));
    const service = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker,
      activateGeneration: activationSnapshot,
    });

    expect(service.submit(f.request).kind).toBe("accepted");
    await service.onIdle(f.row.wiki_id);
    const first = service.submit(f.request);
    expect(first.kind).toBe("existing");
    if (first.kind !== "existing" || !first.operation.receipt) throw new Error("first purge failed");

    const secondRequest: SourcePurgeRequest = {
      ...f.request,
      operation_id: "purge_operation_0002",
      target: f.remaining[0]!,
      remaining_manifest: [],
      residue_markers: ["remaining body safe phrase"],
    };
    expect(service.submit(secondRequest).kind).toBe("accepted");
    await service.onIdle(f.row.wiki_id);
    const second = service.submit(secondRequest);
    expect(second.kind).toBe("existing");
    if (second.kind !== "existing" || !second.operation.receipt) throw new Error("second purge failed");
    expect(second.operation).toMatchObject({ status: "succeeded", phase: "succeeded" });
    expect(second.operation.receipt.remaining_source_count).toBe(0);
    expect(readFileSync(
      activeGenerationPath(f.wikiService.storageRootFor(SERVICE_ID, TEAM_ID, f.row.wiki_id)),
      "utf-8",
    )).toContain(secondRequest.operation_id);
    expect(scanRawManifest(f.wikiService.dirFor(SERVICE_ID, TEAM_ID, f.row.wiki_id))).toEqual([]);
    expect(worker).toHaveBeenCalledTimes(2);
    f.raw.close();
  });

  it("keeps the first active generation when a later purge fails before publication", async () => {
    const f = fixture();
    let build = 0;
    const service = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker: async (ctx) => {
        build++;
        if (build === 2) throw new Error("second generation build failed");
        return deterministicWorker()(ctx);
      },
      activateGeneration: activationSnapshot,
    });

    expect(service.submit(f.request).kind).toBe("accepted");
    await service.onIdle(f.row.wiki_id);
    const storageRoot = f.wikiService.storageRootFor(SERVICE_ID, TEAM_ID, f.row.wiki_id);
    const firstPointer = readFileSync(activeGenerationPath(storageRoot), "utf-8");
    const secondRequest: SourcePurgeRequest = {
      ...f.request,
      operation_id: "purge_operation_0003",
      target: f.remaining[0]!,
      remaining_manifest: [],
      residue_markers: ["remaining body safe phrase"],
    };

    expect(service.submit(secondRequest).kind).toBe("accepted");
    await service.onIdle(f.row.wiki_id);
    const second = service.submit(secondRequest);
    expect(second.kind).toBe("existing");
    if (second.kind !== "existing") throw new Error("unexpected result");
    expect(second.operation).toMatchObject({ status: "failed", phase: "failed", receipt: null });
    expect(readFileSync(activeGenerationPath(storageRoot), "utf-8")).toBe(firstPointer);
    expect(scanRawManifest(f.wikiService.dirFor(SERVICE_ID, TEAM_ID, f.row.wiki_id))).toEqual(f.remaining);
    expect(f.wikiService.isWriteFenced(SERVICE_ID, TEAM_ID, f.row.wiki_id)).toBe(false);
    f.raw.close();
  });

  it("recovers CLEANING after the retired generation was removed without deleting the active generation", async () => {
    const f = fixture();
    const first = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker: deterministicWorker(),
      activateGeneration: activationSnapshot,
    });
    expect(first.submit(f.request).kind).toBe("accepted");
    await first.onIdle(f.row.wiki_id);

    const storageRoot = f.wikiService.storageRootFor(SERVICE_ID, TEAM_ID, f.row.wiki_id);
    const firstGenerationId = `gen_${createHash("sha256")
      .update(f.request.operation_id).digest("hex").slice(0, 24)}`;
    const secondRequest: SourcePurgeRequest = {
      ...f.request,
      operation_id: "purge_operation_cleaning_recovery_0004",
      target: f.remaining[0]!,
      remaining_manifest: [],
      residue_markers: ["remaining body safe phrase"],
    };
    const secondGenerationId = `gen_${createHash("sha256")
      .update(secondRequest.operation_id).digest("hex").slice(0, 24)}`;
    const secondWorker = emptyGenerationWorker();
    const interrupted = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker: secondWorker,
      activateGeneration: activationSnapshot,
      retireGeneration: (root, previousGenerationId, activeGenerationId) => {
        expect(previousGenerationId).toBe(firstGenerationId);
        expect(activeGenerationId).toBe(secondGenerationId);
        rmSync(join(sourcePurgeGenerationsDir(root), previousGenerationId!), {
          recursive: true,
          force: true,
        });
        throw new Error("simulated crash after retired generation removal");
      },
    });

    expect(interrupted.submit(secondRequest).kind).toBe("accepted");
    await interrupted.onIdle(f.row.wiki_id);
    const interruptedState = interrupted.submit(secondRequest);
    expect(interruptedState.kind).toBe("existing");
    if (interruptedState.kind !== "existing") throw new Error("unexpected result");
    expect(interruptedState.operation).toMatchObject({
      status: "running",
      phase: "cleaning_retired_generation",
      receipt: null,
    });
    const generationsRoot = sourcePurgeGenerationsDir(storageRoot);
    expect(existsSync(join(generationsRoot, firstGenerationId))).toBe(false);
    expect(existsSync(join(generationsRoot, secondGenerationId))).toBe(true);

    const recovered = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker: secondWorker,
      activateGeneration: activationSnapshot,
    });
    expect(recovered.recover()).toBe(1);
    await recovered.onIdle(f.row.wiki_id);
    const terminal = recovered.submit(secondRequest);
    expect(terminal.kind).toBe("existing");
    if (terminal.kind !== "existing") throw new Error("unexpected result");
    expect(terminal.operation).toMatchObject({ status: "succeeded", phase: "succeeded" });
    expect(existsSync(join(generationsRoot, secondGenerationId))).toBe(true);
    expect(secondWorker).toHaveBeenCalledOnce();
    f.raw.close();
  });

  it("withholds success when activation mutates a previously validated generation", async () => {
    const f = fixture(true);
    const worker = deterministicWorker();
    const service = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker,
      activateGeneration: (_wikiId, generationDir) => {
        mkdirSync(join(generationDir, "wiki"), { recursive: true });
        const content = "---\ntype: index\ntitle: index\nsources: []\n---\n\n# index\n";
        writeFileSync(join(generationDir, "wiki", "index.md"), content, "utf-8");
        withWriteDb(generationDir, (db) => {
          db.prepare("INSERT INTO page_meta(page_id,title,type,rel_path,snippet) VALUES (?,?,?,?,?)")
            .run("index", "index", "index", "wiki/index.md", "index");
          db.prepare("INSERT INTO wiki_fts(page_id,title_tok,content_tok) VALUES (?,?,?)")
            .run("index", "index", "index");
        });
        return { pageCount: 0 };
      },
    });

    expect(service.submit(f.request).kind).toBe("accepted");
    await service.onIdle(f.row.wiki_id);
    const result = service.submit(f.request);
    expect(result.kind).toBe("existing");
    if (result.kind !== "existing") throw new Error("unexpected result");
    expect(result.operation).toMatchObject({ status: "running", phase: "generation_published", receipt: null });
    expect(f.wikiService.isWriteFenced(SERVICE_ID, TEAM_ID, f.row.wiki_id)).toBe(true);
    const root = f.wikiService.storageRootFor(SERVICE_ID, TEAM_ID, f.row.wiki_id);
    expect(readFileSync(join(root, "raw", "sources", "target.md"), "utf-8")).toContain(MARKER);
    f.raw.close();
  });

  it("quarantines a published operation when its active generation pointer disappears", async () => {
    const f = fixture();
    const worker = deterministicWorker();
    const first = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker,
      activateGeneration: () => { throw new Error("pause after publish"); },
    });
    expect(first.submit(f.request).kind).toBe("accepted");
    await first.onIdle(f.row.wiki_id);
    const storageRoot = f.wikiService.storageRootFor(SERVICE_ID, TEAM_ID, f.row.wiki_id);
    const generationId = `gen_${createHash("sha256").update(f.request.operation_id).digest("hex").slice(0, 24)}`;
    const generationDir = join(sourcePurgeGenerationsDir(storageRoot), generationId);
    expect(scanRawManifest(generationDir)).toEqual(f.remaining);
    rmSync(activeGenerationPath(storageRoot));

    const recovered = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker,
      activateGeneration: activationSnapshot,
    });
    expect(recovered.recover()).toBe(1);
    await recovered.onIdle(f.row.wiki_id);
    expect(scanRawManifest(generationDir)).toEqual(f.remaining);
    expect(readFileSync(join(storageRoot, "raw", "sources", "target.md"), "utf-8")).toContain(MARKER);
    expect(f.wikiService.isWriteFenced(SERVICE_ID, TEAM_ID, f.row.wiki_id)).toBe(true);
    f.raw.close();
  });

  it("recovers after the generation pointer was published but the response path crashed", async () => {
    const f = fixture();
    const worker = deterministicWorker();
    const first = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker,
      activateGeneration: () => { throw new Error("simulated post-publish crash"); },
    });
    expect(first.submit(f.request).kind).toBe("accepted");
    await first.onIdle(f.row.wiki_id);
    const interrupted = first.submit(f.request);
    expect(interrupted.kind).toBe("existing");
    if (interrupted.kind !== "existing") throw new Error("unexpected result");
    expect(interrupted.operation).toMatchObject({ status: "running", phase: "generation_published" });
    expect(worker).toHaveBeenCalledOnce();

    // Also model the narrow crash window where the durable journal survives
    // but active-operation.json does not.
    rmSync(activeOperationPath(f.wikiService.storageRootFor(SERVICE_ID, TEAM_ID, f.row.wiki_id)));

    const recovered = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker,
      activateGeneration: activationSnapshot,
    });
    expect(recovered.recover()).toBe(1);
    await recovered.onIdle(f.row.wiki_id);
    const final = recovered.submit(f.request);
    expect(final.kind).toBe("existing");
    if (final.kind !== "existing") throw new Error("unexpected result");
    expect(final.operation.status).toBe("succeeded");
    expect(worker).toHaveBeenCalledOnce();
    f.raw.close();
  });

  it("lets an identical response-loss retry resume a post-publish operation", async () => {
    const f = fixture();
    const worker = deterministicWorker();
    let activations = 0;
    const service = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker,
      activateGeneration: (wikiId, generationDir) => {
        activations++;
        if (activations === 1) throw new Error("simulated lost response");
        return activationSnapshot(wikiId, generationDir);
      },
    });
    expect(service.submit(f.request).kind).toBe("accepted");
    await service.onIdle(f.row.wiki_id);
    const retry = service.submit(f.request);
    expect(retry.kind).toBe("existing");
    await service.onIdle(f.row.wiki_id);
    const complete = service.submit(f.request);
    expect(complete.kind).toBe("existing");
    if (complete.kind !== "existing") throw new Error("unexpected result");
    expect(complete.operation.status).toBe("succeeded");
    expect(worker).toHaveBeenCalledOnce();
    expect(activations).toBe(2);
    f.raw.close();
  });

  it("fails closed when the exact target plus remaining manifest no longer matches", () => {
    const f = fixture();
    const service = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker: deterministicWorker(),
      activateGeneration: activationSnapshot,
    });
    const wrong: SourceManifestEntry = {
      ...f.request.target,
      sha256: createHash("sha256").update("wrong").digest("hex"),
    };
    const result = service.submit({ ...f.request, target: wrong });
    expect(result.kind).toBe("manifest_mismatch");
    expect(f.wikiService.isWriteFenced(SERVICE_ID, TEAM_ID, f.row.wiki_id)).toBe(false);
    f.raw.close();
  });

  it("keeps the legacy generation and restores metadata when residue validation fails", async () => {
    const f = fixture();
    const baseWorker = deterministicWorker();
    const leakingWorker = vi.fn(async (ctx: SourcePurgeBuildContext) => {
      const result = await baseWorker(ctx);
      const page = join(ctx.stagingDir, "wiki", "concepts", "remaining-1.md");
      writeFileSync(page, `${readFileSync(page, "utf-8")}\n${MARKER}\n`, "utf-8");
      return result;
    });
    const service = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker: leakingWorker,
      activateGeneration: activationSnapshot,
    });

    expect(service.submit(f.request).kind).toBe("accepted");
    await service.onIdle(f.row.wiki_id);
    const failed = service.submit(f.request);
    expect(failed.kind).toBe("existing");
    if (failed.kind !== "existing") throw new Error("unexpected result");
    expect(failed.operation).toMatchObject({ status: "failed", phase: "failed", receipt: null });
    expect(scanRawManifest(f.wikiService.dirFor(SERVICE_ID, TEAM_ID, f.row.wiki_id))).toHaveLength(2);
    expect(f.store.getWiki(SERVICE_ID, TEAM_ID, f.row.wiki_id)).toMatchObject({
      status: "ready",
      summary: `old ${MARKER}`,
    });
    expect(f.wikiService.isWriteFenced(SERVICE_ID, TEAM_ID, f.row.wiki_id)).toBe(false);
    f.raw.close();
  });

  it("refuses a tampered journal before any retired-generation cleanup", async () => {
    const f = fixture();
    const service = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker: deterministicWorker(),
      activateGeneration: () => { throw new Error("pause after pointer publication"); },
    });
    expect(service.submit(f.request).kind).toBe("accepted");
    await service.onIdle(f.row.wiki_id);

    const storageRoot = f.wikiService.storageRootFor(SERVICE_ID, TEAM_ID, f.row.wiki_id);
    const journalPath = join(sourcePurgeOperationsDir(storageRoot), `${f.request.operation_id}.json`);
    const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as Record<string, unknown>;
    journal.previous_generation_id = "../../outside";
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, "utf-8");
    const outside = join(storageRoot, "outside", "sentinel");
    mkdirSync(join(outside, ".."), { recursive: true });
    writeFileSync(outside, "must-survive", "utf-8");

    const recovered = new WikiSourcePurgeService({
      store: f.store,
      wikiService: f.wikiService,
      dataRoot: join(f.root, "data"),
      worker: deterministicWorker(),
      activateGeneration: activationSnapshot,
    });
    expect(recovered.recover()).toBe(0);
    expect(readFileSync(outside, "utf-8")).toBe("must-survive");
    expect(f.wikiService.isWriteFenced(SERVICE_ID, TEAM_ID, f.row.wiki_id)).toBe(true);
    f.raw.close();
  });

  it("rejects a valid journal displaced beneath a different wiki root", async () => {
    const source = fixture();
    const service = new WikiSourcePurgeService({
      store: source.store,
      wikiService: source.wikiService,
      dataRoot: join(source.root, "data"),
      worker: deterministicWorker(),
      activateGeneration: activationSnapshot,
    });
    expect(service.submit(source.request).kind).toBe("accepted");
    await service.onIdle(source.row.wiki_id);

    const sourceJournal = join(
      sourcePurgeOperationsDir(source.wikiService.storageRootFor(SERVICE_ID, TEAM_ID, source.row.wiki_id)),
      `${source.request.operation_id}.json`,
    );
    const destination = fixture();
    const displacedJournal = join(
      sourcePurgeOperationsDir(destination.wikiService.storageRootFor(SERVICE_ID, TEAM_ID, destination.row.wiki_id)),
      `${source.request.operation_id}.json`,
    );
    mkdirSync(join(displacedJournal, ".."), { recursive: true });
    writeFileSync(displacedJournal, readFileSync(sourceJournal));

    const recovered = new WikiSourcePurgeService({
      store: destination.store,
      wikiService: destination.wikiService,
      dataRoot: join(destination.root, "data"),
      worker: deterministicWorker(),
      activateGeneration: activationSnapshot,
    });
    expect(recovered.recover()).toBe(0);
    expect(scanRawManifest(destination.wikiService.dirFor(SERVICE_ID, TEAM_ID, destination.row.wiki_id)))
      .toHaveLength(2);
    source.raw.close();
    destination.raw.close();
  });
});
