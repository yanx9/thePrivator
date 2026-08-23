import type { ProfileIdentity, ProfileRecord } from "../sidecar/types";

/**
 * Profile records for tests.
 *
 * The record has twelve required sections, so building one inline is 60 lines of
 * noise that hides the one field a test is actually about. This keeps the field
 * under test visible and everything else out of the way.
 */

let seq = 0;

/**
 * Every surface reporting the real machine.
 *
 * Written out rather than cast, so that adding a surface to ProfileIdentity
 * fails this file at compile time instead of silently leaving the new surface
 * undefined in every test row.
 */
function realIdentity(): ProfileIdentity {
  return {
    identityVersion: 2,
    label: "Real device",
    presetId: null,
    browser: { mode: "real" },
    navigator: { mode: "real" },
    screen: { mode: "real" },
    locale: { mode: "real" },
    canvas: { mode: "real" },
    audio: { mode: "real" },
    webgl: { mode: "real" },
    webrtc: { mode: "real", policy: "real" },
    geolocation: { mode: "real", permission: "prompt" },
    mediaDevices: { mode: "real" },
    ports: { mode: "real" },
  };
}

export interface ProfileOverrides {
  id?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  folderId?: string | null;
  tags?: string[];
  notes?: string;
  favorite?: boolean;
  deletedAt?: string | null;
  lastLaunchedAt?: string | null;
  launchCount?: number;
  proxyHost?: string;
  proxyPort?: number;
  fingerprintMode?: ProfileRecord["defaults"]["fingerprintMode"];
}

export function makeProfile(overrides: ProfileOverrides = {}): ProfileRecord {
  seq += 1;
  const id = overrides.id ?? `profile-${seq}`;
  const proxy: ProfileRecord["proxy"] =
    overrides.proxyHost === undefined
      ? { proxyVersion: 1, mode: "direct", credentialState: "none", summary: "Direct connection" }
      : {
          proxyVersion: 1,
          mode: "fixedServer",
          protocol: "http",
          host: overrides.proxyHost,
          port: overrides.proxyPort ?? 8080,
          credentialState: "none",
          summary: `http://${overrides.proxyHost}:${overrides.proxyPort ?? 8080}`,
        };

  return {
    id,
    name: overrides.name ?? `Profile ${seq}`,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
    defaults: {
      browser: "chromium",
      startUrl: "about:blank",
      proxyMode: proxy.mode,
      fingerprintMode: overrides.fingerprintMode ?? "disabled",
    },
    storage: { profileDir: `/store/${id}`, userDataDir: `/store/${id}/user-data` },
    identity: realIdentity(),
    proxy,
    organization: {
      folderId: overrides.folderId ?? null,
      tags: overrides.tags ?? [],
      notes: overrides.notes ?? "",
      favorite: overrides.favorite ?? false,
      color: null,
    },
    launch: { startupBehavior: "customUrls", startUrls: [], args: [] },
    lifecycle: {
      deletedAt: overrides.deletedAt ?? null,
      lastLaunchedAt: overrides.lastLaunchedAt ?? null,
      launchCount: overrides.launchCount ?? 0,
    },
    sync: {
      revision: 1,
      updatedBy: "device-a",
      originDeviceId: "device-a",
      lastSyncedAt: null,
      lastSyncedRevision: null,
    },
  };
}
