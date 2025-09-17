import { SyncAction } from './index';
import type { ApiFunctions, PendingChange } from './types';

const SYNC_FIELDS = ['_localId', 'updated_at', 'deleted'] as const;

export function nextLocalId(): string {
    return crypto.randomUUID();
}

export function orderFor(a: SyncAction): number {
    switch (a) {
        case SyncAction.Create:
            return 1;
        case SyncAction.Update:
            return 2;
        case SyncAction.Remove:
            return 3;
    }
}

export function omitSyncFields(item: any) {
    const result = { ...item };
    for (const k of SYNC_FIELDS) delete result[k];
    return result;
}

export function samePendingVersion(get: any, stateKey: string, localId: string, version: number): boolean {
    const q: PendingChange[] = get().syncState.pendingChanges || [];
    const curChange = q.find((p) => p.localId === localId && p.stateKey === stateKey);
    return curChange?.version === version;
}

export function removeFromPendingChanges(set: any, localId: string, stateKey: string) {
    set((s: any) => {
        const queue: PendingChange[] = (s.syncState.pendingChanges || []).filter((p: PendingChange) => !(p.localId === localId && p.stateKey === stateKey));
        return {
            syncState: {
                ...(s.syncState || {}),
                pendingChanges: queue,
            },
        };
    });
}

export function tryAddToPendingChanges(pendingChanges: PendingChange[], stateKey: string, changes: Map<string, ChangeRecord>) {
    for (const [localId, change] of changes) {
        let omittedItem = omitSyncFields(change.changes);
        const queueItem = pendingChanges.find((p) => p.localId === localId && p.stateKey === stateKey);
        const hasChanges = Object.keys(omittedItem).length > 0;
        const action = change.updatedItem === null ? SyncAction.Remove : change.currentItem === null ? SyncAction.Create : SyncAction.Update;

        if (action === SyncAction.Update && change.updatedItem && change.currentItem && change.currentItem._localId !== change.updatedItem._localId) {
            // Here when insert-remote-record swaps local remotely deleted item with a fresh copy to push up
            omittedItem = omitSyncFields(change.updatedItem);
        }

        if (queueItem) {
            if (queueItem.action === SyncAction.Remove) {
                // Once a Remove is queued, it stays a Remove
                continue;
            }

            queueItem.version += 1;

            if (action === SyncAction.Remove) {
                queueItem.action = SyncAction.Remove;
            } else if (hasChanges) {
                // Never change the action here, it stays Create or Update and is removed when synced
                queueItem.changes = { ...queueItem.changes, ...omittedItem };
            }
        } else if (action === SyncAction.Remove || hasChanges) {
            pendingChanges.push({ action, stateKey, localId, id: change.id, version: 1, changes: omittedItem });
        }
    }
}

export function setPendingChangeToUpdate(get: any, stateKey: string, localId: string, id?: any) {
    // id is optional as the user may client assign the id, but not return it from the api
    const pendingChanges: PendingChange[] = get().syncState.pendingChanges || [];
    const change = pendingChanges.find((p) => p.stateKey === stateKey && p.localId === localId);
    if (change) {
        change.action = SyncAction.Update;
        if (id) change.id = id;
    }
}

export function findApi(stateKey: string, syncApi: Record<string, ApiFunctions>) {
    const api = syncApi[stateKey];
    if (!api || !api.add || !api.update || !api.remove || !api.list || !api.firstLoad) {
        throw new Error(`Missing API function(s) for state key: ${stateKey}.`);
    }
    return api;
}

type ChangeRecord = {
    currentItem?: any;
    updatedItem?: any;
    changes: any;
    id?: any;
};

/**
 * Compares the top-level keys of items in `current` and `updated` arrays (assumed to have `_localId`).
 * Returns a Map where the key is `_localId` and the value is an object with:
 * - `currentItem`: The item from `current` (or `null` for additions).
 * - `updatedItem`: The item from `updated` (or `null` for deletions).
 * - `changes`: An object with differing top-level keys and their values (or the full item for additions, or `null` for deletions).
 */
export function findChanges(current: any[], updated: any[]): Map<string, ChangeRecord> {
    const currentMap = new Map<string, any>();
    for (const item of current) {
        if (item && item._localId) {
            currentMap.set(item._localId, { ...item });
        }
    }

    const changesMap = new Map<string, ChangeRecord>();

    // Check for changes and additions
    for (const update of updated) {
        const item = { ...update };
        if (item && item._localId) {
            const curr = currentMap.get(item._localId);
            if (curr) {
                const diff: any = {};
                for (const key in curr) {
                    if (key !== '_localId' && curr[key] !== item[key]) {
                        diff[key] = item[key];
                    }
                }
                if (Object.keys(diff).length > 0) {
                    // Changes
                    changesMap.set(item._localId, { currentItem: curr, updatedItem: item, changes: diff, id: curr.id ?? item.id });
                }
            } else {
                // Addition
                changesMap.set(item._localId, { currentItem: null, updatedItem: item, changes: item, id: item.id });
            }
        }
    }

    // Check for deletions
    for (const [localId, curr] of currentMap) {
        if (!updated.some((u) => u && u._localId === localId)) {
            changesMap.set(localId, { currentItem: curr, updatedItem: null, changes: null, id: curr.id });
        }
    }

    return changesMap;
}
