import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createWikiRoutes } from "./wiki.js";
import type { WikiService, WikiSourcePurgeService } from "../store/index.js";
import type { WikiSourceManager } from "../engines/wiki/index.js";

const body = {
  team_id: "team-1",
  user_id: "writer-1",
  wiki_id: "wiki-1",
  operation_id: "purge_operation_0001",
  target: { filename: "target.md", sha256: "a".repeat(64), size: 10 },
  remaining_manifest: [{ filename: "keep.md", sha256: "b".repeat(64), size: 8 }],
  residue_markers: ["unique-target-marker"],
};

function appFor(token: string, submit = vi.fn(() => ({
  kind: "accepted" as const,
  operation: {
    operation_id: body.operation_id,
    operation_fingerprint: "c".repeat(64),
    status: "pending" as const,
    phase: "accepted" as const,
    receipt: null,
    error: null,
  },
}))) {
  const app = new Hono();
  app.route("/wiki", createWikiRoutes({
    wikiService: {} as WikiService,
    wikiSourcePurgeService: { submit } as unknown as WikiSourcePurgeService,
    wikiMgr: {} as WikiSourceManager,
    publicBaseUrl: "",
    sourcePurgeAuthToken: token,
  }));
  return { app, submit };
}

const headers = {
  "content-type": "application/json",
  "x-tdai-service-id": "service-1",
};

describe("wiki source purge/rebuild route", () => {
  it("fails closed when the destructive endpoint bearer is not configured", async () => {
    const { app } = appFor("");
    const response = await app.request("/wiki/source/purge-rebuild", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(503);
  });

  it("rejects a missing or incorrect internal bearer", async () => {
    const { app, submit } = appFor("internal-secret");
    const response = await app.request("/wiki/source/purge-rebuild", {
      method: "POST",
      headers: { ...headers, authorization: "Bearer wrong-secret" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(401);
    expect(submit).not.toHaveBeenCalled();
  });

  it("accepts and forwards the exact manifest under a valid internal bearer", async () => {
    const { app, submit } = appFor("internal-secret");
    const response = await app.request("/wiki/source/purge-rebuild", {
      method: "POST",
      headers: { ...headers, authorization: "Bearer internal-secret" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(202);
    expect(submit).toHaveBeenCalledWith({
      operation_id: body.operation_id,
      service_id: "service-1",
      team_id: "team-1",
      wiki_id: "wiki-1",
      target: body.target,
      remaining_manifest: body.remaining_manifest,
      residue_markers: body.residue_markers,
      requester_user_id: "writer-1",
    });
  });
});
