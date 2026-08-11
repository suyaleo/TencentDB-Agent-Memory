import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { WikiSourceManager } from "../engines/wiki/index.js";
import type { CodeGraphInstancePool } from "../module.js";
import type { CodeGraphService, WikiService } from "../store/index.js";
import { createToolsRoutes } from "./tools.js";

describe("Agent tools source-purge fence", () => {
  it("does not expose the manager view while the file generation is committing", async () => {
    const search = vi.fn();
    const wikiService = {
      getById: () => ({
        wiki_id: "wiki-1234abcd",
        team_id: "team-1",
        status: "ready",
        name: "fenced wiki",
      }),
      isWriteFenced: () => true,
    } as unknown as WikiService;
    const wikiMgr = { search } as unknown as WikiSourceManager;
    const app = new Hono();
    app.route("/tools", createToolsRoutes({
      wikiService,
      wikiMgr,
      cgService: {} as CodeGraphService,
      instancePool: {} as CodeGraphInstancePool,
    }));

    const response = await app.request("/tools/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": "service-1",
      },
      body: JSON.stringify({
        knowledge_id: "wiki-1234abcd",
        tool_name: "search",
        params: { query: "marker" },
      }),
    });

    expect(response.status).toBe(409);
    expect(search).not.toHaveBeenCalled();
  });
});
