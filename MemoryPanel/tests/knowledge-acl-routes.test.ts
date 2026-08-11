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
  wikiSourcePurgeRebuild = vi.fn(async () => ({
    operation_id: 'purge-operation-0001',
    operation_fingerprint: 'f'.repeat(64),
    status: 'pending' as const,
    phase: 'accepted',
    receipt: null,
    error: null,
  })),
  wikiGet = vi.fn(async () => ({
    wiki_id: 'wiki-1', team_id: 'team-1', name: 'Wiki', service_url: 'http://knowledge/v3',
    owner_user_id: 'owner-1',
  })),
): {
  deps: PanelDeps;
  wikiRawWrite: typeof wikiRawWrite;
  wikiSourcePurgeRebuild: typeof wikiSourcePurgeRebuild;
  kernelPostEnvelope: ReturnType<typeof vi.fn>;
} {
  const knowledgeClient = { wikiRawWrite, wikiSourcePurgeRebuild, wikiGet } as unknown as KnowledgeClientPort;
  const kernelPostEnvelope = vi.fn(async (path: string) =>
    path === '/v3/knowledge/update' || path === '/v3/knowledge/get'
      ? envelope({ knowledge_id: 'wiki-1', type: 'wiki', summary: null, team_id: 'team-1' })
      : envelope({}));
  const deps = {
    config: { metadataRemoteTimeoutMs: 1000 },
    instanceRegistry: new InstanceRegistry([{
      instance_id: 'service-1',
      name: 'test',
      gateway_endpoint: 'http://127.0.0.1:8095',
      api_key: 'test-only-api-key',
    }]),
    metaKernel: { invoke },
    kernelHttp: { postEnvelope: kernelPostEnvelope },
    knowledgeClientFactory: () => knowledgeClient,
  } as unknown as PanelDeps;
  return { deps, wikiRawWrite, wikiSourcePurgeRebuild, kernelPostEnvelope };
}

const purgeBody = {
  team_id: 'team-1',
  wiki_id: 'wiki-1',
  operation_id: 'purge-operation-0001',
  target: { filename: 'target.md', sha256: 'a'.repeat(64), size: 12 },
  remaining_manifest: [{ filename: 'keep.md', sha256: 'b'.repeat(64), size: 9 }],
  residue_markers: ['unique-deletion-marker'],
};

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

  it('requires asset write permission for source purge/rebuild', async () => {
    const invoke = vi.fn(async (action: string) => {
      if (action === 'auth/verify') return envelope({ valid: true, user: { user_id: 'reader-1' } });
      if (action === 'asset/get') return envelope({ asset_id: 'wiki-1', team_id: 'team-1' });
      if (action === 'acl/check') return envelope({ allowed: false });
      if (action === 'team-member/get') return envelope({ role: 'member', status: 'active' });
      throw new Error(`unexpected meta action: ${action}`);
    });
    const { deps, wikiSourcePurgeRebuild } = makeDeps(invoke);
    const app = new Hono();
    registerKnowledgeWikiRoutes(app, deps);

    const response = await app.request('/knowledge/wiki/source/purge-rebuild', {
      method: 'POST', headers, body: JSON.stringify(purgeBody),
    });
    expect(response.status).toBe(403);
    expect(wikiSourcePurgeRebuild).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      'acl/check',
      { user_id: 'reader-1', asset_id: 'wiki-1', action: 'write' },
      expect.any(Object),
    );
  });

  it('requires the purge body team to exactly match the authoritative asset team', async () => {
    const invoke = vi.fn(async (action: string) => {
      if (action === 'auth/verify') return envelope({ valid: true, user: { user_id: 'writer-1' } });
      if (action === 'asset/get') return envelope({ asset_id: 'wiki-1', team_id: 'team-authoritative' });
      if (action === 'acl/check') return envelope({ allowed: true });
      if (action === 'team-member/get') return envelope({ role: 'member', status: 'active' });
      throw new Error(`unexpected meta action: ${action}`);
    });
    const { deps, wikiSourcePurgeRebuild } = makeDeps(invoke);
    const app = new Hono();
    registerKnowledgeWikiRoutes(app, deps);

    const response = await app.request('/knowledge/wiki/source/purge-rebuild', {
      method: 'POST', headers, body: JSON.stringify(purgeBody),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ message: 'TEAM_MISMATCH' });
    expect(wikiSourcePurgeRebuild).not.toHaveBeenCalled();
  });

  it('forwards an exact purge manifest only after authenticated writer ACL and team gates pass', async () => {
    const invoke = vi.fn(async (action: string) => {
      if (action === 'auth/verify') return envelope({ valid: true, user: { user_id: 'writer-1' } });
      if (action === 'asset/get') return envelope({ asset_id: 'wiki-1', team_id: 'team-1' });
      if (action === 'acl/check') return envelope({ allowed: true });
      if (action === 'team-member/get') return envelope({ role: 'member', status: 'active' });
      throw new Error(`unexpected meta action: ${action}`);
    });
    const { deps, wikiSourcePurgeRebuild } = makeDeps(invoke);
    const app = new Hono();
    registerKnowledgeWikiRoutes(app, deps);

    const response = await app.request('/knowledge/wiki/source/purge-rebuild', {
      method: 'POST', headers, body: JSON.stringify(purgeBody),
    });
    expect(response.status).toBe(200);
    expect(wikiSourcePurgeRebuild).toHaveBeenCalledWith(purgeBody, 'writer-1');
  });

  it('withholds a terminal receipt until the kernel knowledge summary is cleared', async () => {
    const invoke = vi.fn(async (action: string) => {
      if (action === 'auth/verify') return envelope({ valid: true, user: { user_id: 'writer-1' } });
      if (action === 'asset/get') return envelope({ asset_id: 'wiki-1', team_id: 'team-1' });
      if (action === 'acl/check') return envelope({ allowed: true });
      if (action === 'team-member/get') return envelope({ role: 'member', status: 'active' });
      throw new Error(`unexpected meta action: ${action}`);
    });
    const terminal = vi.fn(async () => ({
      operation_id: 'purge-operation-0001', operation_fingerprint: 'f'.repeat(64),
      status: 'succeeded' as const, phase: 'succeeded', receipt: { residue_matches: 0 }, error: null,
    }));
    const { deps, kernelPostEnvelope } = makeDeps(invoke, undefined, terminal);
    const app = new Hono();
    registerKnowledgeWikiRoutes(app, deps);

    const response = await app.request('/knowledge/wiki/source/purge-rebuild', {
      method: 'POST', headers, body: JSON.stringify(purgeBody),
    });
    expect(response.status).toBe(200);
    expect(kernelPostEnvelope).toHaveBeenCalledWith(
      '/v3/knowledge/update',
      { knowledge_id: 'wiki-1', summary: null, team_id: 'team-1' },
      expect.objectContaining({ instanceId: 'service-1', userKey: undefined }),
    );
    expect(kernelPostEnvelope).toHaveBeenCalledWith(
      '/v3/knowledge/get',
      { knowledge_id: 'wiki-1', team_id: 'team-1' },
      expect.objectContaining({ instanceId: 'service-1', userKey: undefined }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { receipt: { residue_matches: 0, panel_summary_cleared: true } },
    });
  });

  it('fails closed when the kernel summary clear cannot be read back exactly', async () => {
    const invoke = vi.fn(async (action: string) => {
      if (action === 'auth/verify') return envelope({ valid: true, user: { user_id: 'writer-1' } });
      if (action === 'asset/get') return envelope({ asset_id: 'wiki-1', team_id: 'team-1' });
      if (action === 'acl/check') return envelope({ allowed: true });
      if (action === 'team-member/get') return envelope({ role: 'member', status: 'active' });
      throw new Error(`unexpected meta action: ${action}`);
    });
    const terminal = vi.fn(async () => ({
      operation_id: 'purge-operation-0001', operation_fingerprint: 'f'.repeat(64),
      status: 'succeeded' as const, phase: 'succeeded', receipt: { residue_matches: 0 }, error: null,
    }));
    const { deps, kernelPostEnvelope } = makeDeps(invoke, undefined, terminal);
    kernelPostEnvelope.mockImplementation(async (path: string) => {
      if (path === '/v3/knowledge/update') {
        return envelope({ knowledge_id: 'wiki-1', type: 'wiki', summary: null, team_id: 'team-1' });
      }
      if (path === '/v3/knowledge/get') {
        return envelope({ knowledge_id: 'wiki-1', type: 'wiki', summary: 'stale', team_id: 'team-1' });
      }
      return envelope({});
    });
    const app = new Hono();
    registerKnowledgeWikiRoutes(app, deps);

    const response = await app.request('/knowledge/wiki/source/purge-rebuild', {
      method: 'POST', headers, body: JSON.stringify(purgeBody),
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.not.toMatchObject({
      data: { receipt: { panel_summary_cleared: true } },
    });
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
