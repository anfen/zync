import { type ApiFunctions, type FieldConflict, type ConflictResolutionStrategy, type SyncedRecord, type PendingChange } from './types';
import { SyncAction } from './index';
import { createLocalId, hasKeysOrUndefined } from './helpers';
import type { Logger } from './logger';

export async function pull(set: any, get: any, stateKey: string, api: ApiFunctions, logger: Logger, conflictResolutionStrategy: ConflictResolutionStrategy) {
    const lastPulled: Record<string, string> = get().syncState.lastPulled || {};
    const lastPulledAt = new Date(lastPulled[stateKey] || new Date(0));

    logger.debug(`[zync] pull:start stateKey=${stateKey} since=${lastPulledAt.toISOString()}`);

    const serverData = (await api.list(lastPulledAt)) as SyncedRecord[];
    if (!serverData?.length) return;

    let newest = lastPulledAt;

    set((state: any) => {
        let pendingChanges = [...(state.syncState.pendingChanges as PendingChange[])];
        const conflicts = { ...state.syncState.conflicts };
        const localItems: any[] = state[stateKey] || [];
        let nextItems = [...localItems];

        const localById = new Map<any, any>(localItems.filter((l) => l.id).map((l) => [l.id, l]));
        // prevent resurrecting deleted items when pulling them again
        const pendingRemovalById = new Set(pendingChanges.filter((p) => p.stateKey === stateKey && p.action === SyncAction.Remove).map((p) => p.id));

        for (const remote of serverData) {
            const remoteUpdated = new Date(remote.updated_at);
            if (remoteUpdated > newest) newest = remoteUpdated;

            // If a Remove is pending for this localId, skip merging/adding to avoid briefly resurrecting the item
            if (pendingRemovalById.has(remote.id)) {
                logger.debug(`[zync] pull:skip-pending-remove stateKey=${stateKey} id=${remote.id}`);
                continue;
            }

            const localItem = localById.get(remote.id);
            if (remote.deleted) {
                if (localItem) {
                    nextItems = nextItems.filter((i: any) => i.id !== remote.id);
                    logger.debug(`[zync] pull:remove stateKey=${stateKey} id=${remote.id}`);
                }
                continue;
            }

            delete remote.deleted;

            if (localItem) {
                const pendingChange = pendingChanges.find((p: any) => p.stateKey === stateKey && p.localId === localItem._localId);
                if (pendingChange) {
                    logger.debug(`[zync] pull:conflict-strategy:${conflictResolutionStrategy} stateKey=${stateKey} id=${remote.id}`);

                    switch (conflictResolutionStrategy) {
                        case 'client-wins':
                            // Ignore remote changes, keep local
                            break;

                        case 'server-wins': {
                            // Ignore local changes, keep remote
                            const merged = { ...remote, _localId: localItem._localId };
                            nextItems = nextItems.map((i: any) => (i._localId === localItem._localId ? merged : i));
                            // Remove pending change so it isn't pushed after pull
                            pendingChanges = pendingChanges.filter((p) => !(p.stateKey === stateKey && p.localId === localItem._localId));
                            break;
                        }

                        case 'try-shallow-merge': {
                            // List fields that local and remote have changed
                            const changes = pendingChange.changes || {};
                            const before = pendingChange.before || {};
                            const fields: FieldConflict[] = Object.entries(changes)
                                .filter(([k, localValue]) => k in before && k in remote && before[k] !== remote[k] && localValue !== remote[k])
                                .map(([key, localValue]) => ({ key, localValue, remoteValue: remote[key] }));

                            if (fields.length > 0) {
                                logger.warn(`[zync] pull:${conflictResolutionStrategy}:conflicts-found`, JSON.stringify(fields, null, 4));
                                conflicts[localItem._localId] = { stateKey, fields };
                            } else {
                                // No conflicts, merge remote into local but only preserve fields that were
                                // actually changed locally
                                const localChangedKeys = Object.keys(changes);
                                const preservedLocal: any = { _localId: localItem._localId };
                                for (const k of localChangedKeys) {
                                    if (k in localItem) preservedLocal[k] = localItem[k];
                                }

                                const merged = { ...remote, ...preservedLocal };
                                nextItems = nextItems.map((i: any) => (i._localId === localItem._localId ? merged : i));
                                // Merge now resolved, drop pending and conflict
                                delete conflicts[localItem._localId];
                            }
                            break;
                        }
                    }
                } else {
                    // No pending changes, merge remote into local
                    const merged = { ...localItem, ...remote };
                    nextItems = nextItems.map((i: any) => (i._localId === localItem._localId ? merged : i));
                    logger.debug(`[zync] pull:merge-remote stateKey=${stateKey} id=${remote.id}`);
                }
            } else {
                // Add remote item (no local item)
                nextItems = [...nextItems, { ...remote, _localId: createLocalId() }];
                logger.debug(`[zync] pull:add stateKey=${stateKey} id=${remote.id}`);
            }
        }

        return {
            [stateKey]: nextItems,
            syncState: {
                ...(state.syncState || {}),
                pendingChanges,
                conflicts: hasKeysOrUndefined(conflicts),
                lastPulled: {
                    ...(state.syncState.lastPulled || {}),
                    [stateKey]: newest.toISOString(),
                },
            },
        };
    });
}
