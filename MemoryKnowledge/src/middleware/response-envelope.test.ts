import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { accessLog } from "./response-envelope.js";

describe("accessLog request body cache", () => {
  it("lets downstream handlers parse a JSON body after middleware logging consumes it", async () => {
    const app = new Hono();
    app.use("*", accessLog());
    app.post("/echo", async (c) => c.json(await c.req.json()));

    const response = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki_id: "wiki-1", value: 7 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ wiki_id: "wiki-1", value: 7 });
  });
});
