import type { ApiFunctions, ConflictResolutionStrategy, PendingChange, SyncedRecord } from './types';
import { SyncAction } from './index';
import { nextLocalId } from './helpers';
import type { Logger } from './logger';

export async function pull(set: any, get: any, stateKey: string, api: ApiFunctions, logger: Logger, conflictResolutionStrategy: ConflictResolutionStrategy) {
    const lastPulled: Record<string, string> = get().syncState.lastPulled || {};
    const lastPulledAt = new Date(lastPulled[stateKey] || new Date(0));

    logger.debug(`[zync] pull:start stateKey=${stateKey} since=${lastPulledAt.toISOString()}`);

    const serverData = (await api.list(lastPulledAt)) as SyncedRecord[];
    if (!serverData?.length) return;

    let newest = lastPulledAt;
    set((state: any) => {
        const pendingChanges: PendingChange[] = state.syncState.pendingChanges || [];
        const localItems: any[] = state[stateKey] || [];
        let nextItems = [...localItems];
        const localById = new Map<any, any>(localItems.filter((l) => l.id).map((l) => [l.id, l]));
        // prevent resurrecting deleted items by pulling them again
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
                    // TODO: Conflict resolution required
                    switch (conflictResolutionStrategy) {
                        case 'local-wins':
                            // Ignore remote changes, keep local
                            logger.debug(`[zync] pull:conflict-strategy:${conflictResolutionStrategy} stateKey=${stateKey} id=${remote.id}`);
                            break;

                        case 'remote-wins': {
                            // Ignore local changes, keep remote
                            const merged = {
                                ...remote,
                                _localId: localItem._localId,
                            };
                            nextItems = nextItems.map((i: any) => (i._localId === localItem._localId ? merged : i));
                            logger.debug(`[zync] pull:conflict-strategy:${conflictResolutionStrategy} stateKey=${stateKey} id=${remote.id}`);
                            break;
                        }

                        // case 'try-shallow-merge':
                        //     // Try and merge all fields, fail if not possible due to conflicts
                        //     // throw new ConflictError('Details...');
                        //     break;

                        // case 'custom':
                        //     // Hook to allow custom userland logic
                        //     // const error = onConflict(localItem, remote, stateKey, pending);
                        //     // logger.debug(`[zync] pull:conflict-strategy:${conflictResolutionStrategy} stateKey=${stateKey} id=${remote.id} error=${error}`);
                        //     // if (error) throw new ConflictError(error);
                        //     break;

                        default:
                            logger.error(`[zync] pull:conflict-strategy:unknown stateKey=${stateKey} id=${remote.id} strategy=${conflictResolutionStrategy}`);
                            break;
                    }
                } else {
                    // No pending changes, merge remote into local
                    const merged = {
                        ...localItem,
                        ...remote,
                    };
                    nextItems = nextItems.map((i: any) => (i._localId === localItem._localId ? merged : i));
                    logger.debug(`[zync] pull:merge-remote stateKey=${stateKey} id=${remote.id}`);
                }
            } else {
                // Add remote item (no local item)
                nextItems = [...nextItems, { ...remote, _localId: nextLocalId() }];
                logger.debug(`[zync] pull:add stateKey=${stateKey} id=${remote.id}`);
            }
        }

        return {
            [stateKey]: nextItems,
            syncState: {
                ...(state.syncState || {}),
                lastPulled: {
                    ...(state.syncState.lastPulled || {}),
                    [stateKey]: newest.toISOString(),
                },
            },
        };
    });
}
