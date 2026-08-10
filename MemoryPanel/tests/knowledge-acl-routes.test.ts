import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import { registerKnowledgeAllocateRoutes } from '../src/panel/http/routes/knowledge/allocate-routes.js';
import { registerKnowledgeWikiRoutes } from '../src/panel/http/routes/knowledge/wiki-routes.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import type { KnowledgeClientPort } from '../src/panel/kernel/ports/knowledge-client-port.js';

const headers = {
  'content-type': 'application/json',
  'x-tdai-service-id': 'service-1',
  'x-tdai-user-key': 'caller-key',
};

function envelope(data: unknown, code = 0) {
  return { code, message: code === 0 ? 'ok' : 'error', request_id: 'req-1', data };
}

function makeDeps(
  invoke: PanelDeps['metaKernel']['invoke'],
  wikiRawWrite = vi.fn(async () => ({ items: [] })),
): { deps: PanelDeps; wikiRawWrite: typeof wikiRawWrite } {
  const knowledgeClient = { wikiRawWrite } as unknown as KnowledgeClientPort;
  const deps = {
    instanceRegistry: new InstanceRegistry([{
      instance_id: 'service-1',
      name: 'test',
      gateway_endpoint: 'http://127.0.0.1:8095',
      api_key: 'test-only-api-key',
    }]),
    metaKernel: { invoke },
    knowledgeClientFactory: () => knowledgeClient,
  } as unknown as PanelDeps;
  return { deps, wikiRawWrite };
}

describe('knowledge ACL routes', () => {
  it('does not let a team reader write wiki raw sources without write permission', async () => {
    const invoke = vi.fn(async (action: string) => {
      if (action === 'auth/verify') {
        return envelope({ valid: true, user: { user_id: 'reader-1' } });
      }
      if (action === 'asset/get') {
        return envelope({ asset_id: 'wiki-1', team_id: 'team-1' });
      }
      if (action === 'acl/check') return envelope({ allowed: false });
      if (action === 'team-member/get') return envelope({ role: 'member', status: 'active' });
      throw new Error(`unexpected meta action: ${action}`);
    });
    const { deps, wikiRawWrite } = makeDeps(invoke);
    const app = new Hono();
    registerKnowledgeWikiRoutes(app, deps);

    const response = await app.request('/knowledge/wiki/raw/write', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        team_id: 'team-1',
        wiki_id: 'wiki-1',
        files: [{ filename: 'capture.md', content: 'content' }],
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 403, message: 'FORBIDDEN' });
    expect(invoke).toHaveBeenCalledWith(
      'acl/check',
      { user_id: 'reader-1', asset_id: 'wiki-1', action: 'write' },
      expect.any(Object),
    );
    expect(wikiRawWrite).not.toHaveBeenCalled();
  });

  it('denies raw writes when body team_id does not exactly match the asset team', async () => {
    const invoke = vi.fn(async (action: string) => {
      if (action === 'auth/verify') {
        return envelope({ valid: true, user: { user_id: 'writer-1' } });
      }
      if (action === 'asset/get') {
        return envelope({ asset_id: 'wiki-1', team_id: 'team-asset' });
      }
      if (action === 'acl/check') return envelope({ allowed: true });
      if (action === 'team-member/get') return envelope({ role: 'member', status: 'active' });
      throw new Error(`unexpected meta action: ${action}`);
    });
    const { deps, wikiRawWrite } = makeDeps(invoke);
    const app = new Hono();
    registerKnowledgeWikiRoutes(app, deps);

    const response = await app.request('/knowledge/wiki/raw/write', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        team_id: 'team-body',
        wiki_id: 'wiki-1',
        files: [{ filename: 'capture.md', content: 'content' }],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 400, message: 'TEAM_MISMATCH' });
    expect(wikiRawWrite).not.toHaveBeenCalled();
  });

  it('derives acl/grant granted_by from the authenticated caller and ignores body grantors', async () => {
    const invoke = vi.fn(async (action: string, body: Record<string, unknown>) => {
      if (action === 'auth/verify') {
        return envelope({ valid: true, user: { user_id: 'owner-1' } });
      }
      if (action === 'acl/grant') return envelope({ id: 'acl-1', ...body });
      throw new Error(`unexpected meta action: ${action}`);
    });
    const { deps } = makeDeps(invoke);
    const app = new Hono();
    registerKnowledgeAllocateRoutes(app, deps);

    const response = await app.request('/knowledge/grant', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        knowledge_id: 'wiki-1',
        subject_type: 'user',
        subject_id: 'reader-1',
        permission: 'read',
        granted_by: 'attacker-supplied-id',
        granted_by_key: 'attacker-supplied-key',
      }),
    });

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(
      'acl/grant',
      {
        asset_id: 'wiki-1',
        subject_type: 'user',
        subject_id: 'reader-1',
        permission: 'read',
        granted_by: 'owner-1',
      },
      expect.objectContaining({ userKey: 'caller-key' }),
    );
  });
});
