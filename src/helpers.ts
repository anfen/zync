import { SyncAction } from './index';
import type { ApiConfig, ApiFunctions, Conflict, FieldConflict, PendingChange, SyncState } from './types';

const SYNC_FIELDS = ['_localId', 'updated_at', 'deleted'] as const;

export function createLocalId(): string {
    return crypto.randomUUID();
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function changeKeysTo(input: any | any[], toIdKey: string, toUpdatedAtKey: string, toDeletedKey: string) {
    if (!input) return input;
    const isArray = Array.isArray(input);
    const result = (isArray ? input : [input]).map((item) => {
        const { id, updated_at, deleted, ...rest } = item;
        return {
            [toIdKey]: id,
            [toUpdatedAtKey]: updated_at,
            [toDeletedKey]: deleted,
            ...rest,
        };
    });
    return isArray ? result : result[0];
}

export function changeKeysFrom(input: any | any[], fromIdKey: string, fromUpdatedAtKey: string, fromDeletedKey: string) {
    if (!input) return input;
    const isArray = Array.isArray(input);
    const result = (isArray ? input : [input]).map((item) => {
        const { [fromIdKey]: id, [fromUpdatedAtKey]: updated_at, [fromDeletedKey]: deleted, ...rest } = item;
        return {
            id,
            updated_at,
            deleted,
            ...rest,
        };
    });
    return isArray ? result : result[0];
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
    const pending: PendingChange[] = get().syncState.pendingChanges || [];
    const curChange = pending.find((p) => p.localId === localId && p.stateKey === stateKey);
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
        let omittedChanges = omitSyncFields(change.changes);
        const omittedCurrentItem = omitSyncFields(change.currentItem);
        const omittedUpdatedItem = omitSyncFields(change.updatedItem);
        const queueItem = pendingChanges.find((p) => p.localId === localId && p.stateKey === stateKey);
        const hasChanges = Object.keys(omittedChanges).length > 0;
        const action = change.updatedItem === null ? SyncAction.Remove : change.currentItem === null ? SyncAction.Create : SyncAction.Update;

        if (action === SyncAction.Update && change.updatedItem && change.currentItem && change.currentItem._localId !== change.updatedItem._localId) {
            // Here when insert-remote-record swaps local remotely deleted item with a fresh copy to push up
            omittedChanges = omittedUpdatedItem;
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
                queueItem.changes = { ...queueItem.changes, ...omittedChanges };
                queueItem.after = { ...queueItem.after, ...omittedUpdatedItem };
            }
        } else if (action === SyncAction.Remove || hasChanges) {
            pendingChanges.push({
                action,
                stateKey,
                localId,
                id: change.id,
                version: 1,
                changes: omittedChanges,
                before: omittedCurrentItem,
                after: omittedUpdatedItem,
            });
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

export function setPendingChangeBefore(get: any, stateKey: string, localId: string, before: any) {
    const pendingChanges: PendingChange[] = get().syncState.pendingChanges || [];
    const change = pendingChanges.find((p) => p.stateKey === stateKey && p.localId === localId);
    if (change) {
        change.before = { ...change.before, ...before };
    }
}

export function tryUpdateConflicts(pendingChanges: PendingChange[], conflicts?: Record<string, Conflict>): Record<string, Conflict> | undefined {
    if (!conflicts) return conflicts;

    const newConflicts = { ...conflicts };

    for (const change of pendingChanges) {
        const conflict = newConflicts[change.localId];
        if (conflict && change.changes) {
            // Loop changed fields and update their old possibly stale value to the current local value
            const newFields = conflict.fields.map((f) => {
                if (f.key in change.changes) {
                    return { ...f, localValue: change.changes[f.key] } as FieldConflict;
                }
                return f;
            });

            newConflicts[change.localId] = { stateKey: conflict.stateKey, fields: newFields };
        }
    }

    return newConflicts;
}

export function findApi(stateKey: string, syncApi: Record<string, ApiFunctions>): ApiFunctions {
    const api = syncApi[stateKey];
    if (!api || !api.add || !api.update || !api.remove || !api.list) {
        throw new Error(`Missing API function(s) for state key: ${stateKey}.`);
    }

    return api;
}

export function isPullIntervalNow(stateKey: string, apiConfig: Record<string, ApiConfig>, lastPulled: SyncState['syncState']['lastPulled']): boolean {
    const config = apiConfig[stateKey];
    if (!config || !config.pullInterval) {
        return true;
    }

    const lastPulledTime = new Date(lastPulled[stateKey] ?? 0).getTime();
    return Date.now() > lastPulledTime + config.pullInterval;
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

export function hasKeysOrUndefined(obj: any): any {
    return Object.keys(obj).length === 0 ? undefined : obj;
}

export function hasConflicts(get: any, localId: string): boolean {
    const state = get() as SyncState;
    if (state.syncState.conflicts) {
        return !!state.syncState.conflicts[localId];
    }
    return false;
}

export function resolveConflict(set: any, localId: string, keepLocalFields: boolean) {
    set((state: any) => {
        const syncState: SyncState['syncState'] = state.syncState || {};
        const conflicts: Record<string, Conflict> = syncState.conflicts || {};
        const conflict = conflicts[localId];
        if (conflict) {
            const items = state[conflict.stateKey];
            const item = items.find((i: any) => i._localId === localId);
            if (!item) {
                return state;
            }

            const resolved: any = { ...item };
            let pendingChanges = [...syncState.pendingChanges];

            if (!keepLocalFields) {
                // Use remote value(s)
                for (const field of conflict.fields) {
                    resolved[field.key] = field.remoteValue;
                }

                // Remove resolved pending change
                pendingChanges = pendingChanges.filter((p) => !(p.stateKey === conflict.stateKey && p.localId === localId));
            }

            // Replace with resolved item
            const nextItems = items.map((i: any) => (i._localId === localId ? resolved : i));
            const nextConflicts = { ...conflicts };
            delete nextConflicts[localId];

            return {
                [conflict.stateKey]: nextItems,
                syncState: {
                    ...syncState,
                    pendingChanges,
                    conflicts: hasKeysOrUndefined(nextConflicts),
                },
            };
        }
        return state;
    });
}
