import { describe, expect, it, vi } from "vitest";
import type { IMetadataStore } from "../store/interface.js";
import type { AclEntity, AssetEntity, AssetVisibility, TeamMemberEntity } from "../types.js";
import { MetadataService } from "./metadata-service.js";
import { canBindAsset } from "./permission-checker.js";

const NOW = "2026-08-10T00:00:00.000Z";

const member: TeamMemberEntity = {
  id: "member-1",
  team_id: "team-1",
  user_id: "reader-1",
  role: "member",
  joined_at: NOW,
  status: "active",
};

function asset(visibility: AssetVisibility): AssetEntity {
  return {
    asset_id: "wiki-1",
    team_id: "team-1",
    asset_type: "llm_wiki",
    name: "Restricted wiki",
    owner_user_id: "owner-1",
    source_type: "manual",
    version: 1,
    visibility,
    status: "approved",
    usage_count: 0,
    created_at: NOW,
    updated_at: NOW,
    metadata_json: "{}",
  };
}

function readGrant(): AclEntity {
  return {
    id: "acl-reader-read",
    asset_id: "wiki-1",
    subject_type: "user",
    subject_id: "reader-1",
    permission: "read",
    effect: "allow",
    granted_by: "owner-1",
    created_at: NOW,
    updated_at: NOW,
  };
}

function serviceFor(visibility: AssetVisibility, aclRecords: AclEntity[]) {
  const listAclByAsset = vi.fn(() => ({ items: aclRecords, total: aclRecords.length }));
  const store = {
    getAssetById: vi.fn(() => asset(visibility)),
    getTeamMember: vi.fn(() => member),
    listAclByAsset,
  } as unknown as IMetadataStore;
  return { service: new MetadataService(store), listAclByAsset };
}

describe("MetadataService restricted asset ACL", () => {
  it("lazy-loads an explicit read grant for a restricted asset", async () => {
    const { service, listAclByAsset } = serviceFor("restricted", [readGrant()]);

    await expect(service.checkAssetPermission({
      user_id: "reader-1",
      asset_id: "wiki-1",
      action: "read",
    })).resolves.toEqual({ allowed: true, reason: "acl:acl-reader-read" });
    expect(listAclByAsset).toHaveBeenCalledWith("wiki-1", { limit: 100, offset: 0 });
  });

  it("denies a restricted asset when no explicit grant matches", async () => {
    const { service, listAclByAsset } = serviceFor("restricted", []);

    await expect(service.checkAssetPermission({
      user_id: "reader-1",
      asset_id: "wiki-1",
      action: "read",
    })).resolves.toEqual({ allowed: false, reason: "visibility_restricted" });
    expect(listAclByAsset).toHaveBeenCalledOnce();
  });

  it("keeps private assets owner-only even when an ACL row exists", async () => {
    const { service, listAclByAsset } = serviceFor("private", [readGrant()]);

    await expect(service.checkAssetPermission({
      user_id: "reader-1",
      asset_id: "wiki-1",
      action: "read",
    })).resolves.toEqual({ allowed: false, reason: "visibility_restricted" });
    expect(listAclByAsset).not.toHaveBeenCalled();
  });

  it("keeps restricted assets unavailable to agent-fixed-asset binding", () => {
    expect(canBindAsset(
      { team_id: "team-1", owner_user_id: "owner-1" },
      asset("restricted"),
    )).toBe(false);
  });
});
