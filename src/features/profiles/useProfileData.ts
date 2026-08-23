import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getChromiumStatus,
  listProfiles,
  listTrashedProfiles,
  normalizeSidecarError,
} from "../../sidecar/client";
import type { ProfileRecord, SidecarClientError } from "../../sidecar/types";
import { subscribeToProfilesChanged, subscribeToChromiumStatusChanged } from "../../sidecarEvents";
import type { ProfileRow } from "./tableModel";

/**
 * The profile list and its runtime, kept together.
 *
 * They arrive from two commands but describe one thing, and every consumer wants
 * both -- so pairing them here is what stops each caller inventing its own
 * "profiles loaded but status has not arrived yet" state.
 *
 * The sidecar emits an event on every change, and this refreshes on it. The
 * interval underneath is a backstop rather than the mechanism: a browser that
 * dies on its own produces no event, and without a poll the row would claim to
 * be running until the user clicked something.
 */

const STATUS_POLL_MS = 5_000;

export interface ProfileData {
  rows: ProfileRow[];
  trashed: ProfileRecord[];
  runningCount: number;
  loading: boolean;
  error: SidecarClientError | null;
  refresh: () => void;
}

export function useProfileData(includeTrash: boolean): ProfileData {
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [trashed, setTrashed] = useState<ProfileRecord[]>([]);
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SidecarClientError | null>(null);

  // A refresh triggered while an earlier one is still in flight must not be able
  // to land second and overwrite the newer answer with the older one.
  const sequenceRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;

    void (async () => {
      try {
        const [list, status, trash] = await Promise.all([
          listProfiles(),
          getChromiumStatus(),
          includeTrash ? listTrashedProfiles() : Promise.resolve(null),
        ]);

        if (!mountedRef.current || sequenceRef.current !== sequence) {
          return;
        }

        setProfiles(list.profiles);
        setRunningIds(new Set(status.profiles.map((entry) => entry.profileId)));
        setTrashed(trash === null ? [] : trash.profiles);
        setError(null);
      } catch (caught) {
        if (mountedRef.current && sequenceRef.current === sequence) {
          setError(normalizeSidecarError(caught));
        }
      } finally {
        if (mountedRef.current && sequenceRef.current === sequence) {
          setLoading(false);
        }
      }
    })();
  }, [includeTrash]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, STATUS_POLL_MS);
    const unsubscribeProfiles = subscribeToProfilesChanged(refresh);
    const unsubscribeStatus = subscribeToChromiumStatusChanged(refresh);

    return () => {
      window.clearInterval(timer);
      unsubscribeProfiles();
      unsubscribeStatus();
    };
  }, [refresh]);

  const rows = useMemo(
    () => profiles.map((profile) => ({ profile, running: runningIds.has(profile.id) })),
    [profiles, runningIds],
  );

  return { rows, trashed, runningCount: runningIds.size, loading, error, refresh };
}
