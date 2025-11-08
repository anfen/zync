import { hasConflicts, removeFromPendingChanges, samePendingVersion, setPendingChangeBefore, setPendingChangeToUpdate } from './helpers';
import { createLocalId, SyncAction } from './index';
import type { Logger } from './logger';
import type {
    AfterRemoteAddCallback,
    ApiFunctions,
    MissingRemoteRecordStrategy,
    MissingRemoteRecordDuringUpdateCallback,
    PendingChange,
    SetAndSyncCallback,
} from './types';

export async function pushOne(
    set: any,
    get: any,
    change: PendingChange,
    api: ApiFunctions,
    logger: Logger,
    setAndQueueToSync: SetAndSyncCallback,
    missingStrategy: MissingRemoteRecordStrategy,
    onMissingRemoteRecordDuringUpdate?: MissingRemoteRecordDuringUpdateCallback,
    onAfterRemoteAdd?: AfterRemoteAddCallback,
) {
    logger.debug(`[zync] push:attempt action=${change.action} stateKey=${change.stateKey} localId=${change.localId}`);

    const { action, stateKey, localId, id, version, changes, after } = change;

    switch (action) {
        case SyncAction.Remove:
            if (!id) {
                logger.warn(`[zync] push:remove:no-id stateKey=${stateKey} localId=${localId}`);
                removeFromPendingChanges(set, localId, stateKey);
                return;
            }

            await api.remove(id);
            logger.debug(`[zync] push:remove:success stateKey=${stateKey} localId=${localId} id=${id}`);
            removeFromPendingChanges(set, localId, stateKey);
            break;

        case SyncAction.Update: {
            if (hasConflicts(get, change.localId)) {
                logger.warn(`[zync] push:update:skipping-with-conflicts stateKey=${stateKey} localId=${localId} id=${id}`);
                return;
            }

            const exists = await api.update(id, changes, after);
            if (exists) {
                logger.debug(`[zync] push:update:success stateKey=${stateKey} localId=${localId} id=${id}`);
                if (samePendingVersion(get, stateKey, localId, version)) {
                    removeFromPendingChanges(set, localId, stateKey);
                } else {
                    // Item changed during request, ensure pending.before is not stale for conflict resolution
                    setPendingChangeBefore(get, stateKey, localId, changes);
                }
                return;
            } else {
                const state = get();
                const items: any[] = state[stateKey] || [];
                const item = items.find((i) => i._localId === localId);
                if (!item) {
                    logger.warn(`[zync] push:missing-remote:no-local-item stateKey=${stateKey} localId=${localId}`);
                    removeFromPendingChanges(set, localId, stateKey);
                    return;
                }

                switch (missingStrategy) {
                    case 'delete-local-record':
                        set((s: any) => ({
                            [stateKey]: (s[stateKey] || []).filter((i: any) => i._localId !== localId),
                        }));
                        logger.debug(`[zync] push:missing-remote:${missingStrategy} stateKey=${stateKey} id=${item.id}`);
                        break;

                    case 'insert-remote-record': {
                        const newItem = {
                            ...item,
                            _localId: createLocalId(),
                            updated_at: new Date().toISOString(),
                        };

                        // replace old with modified and queue Create
                        setAndQueueToSync((s: any) => ({
                            [stateKey]: (s[stateKey] || []).map((i: any) => (i._localId === localId ? newItem : i)),
                        }));

                        logger.debug(`[zync] push:missing-remote:${missingStrategy} stateKey=${stateKey} id=${newItem.id}`);
                        break;
                    }

                    case 'ignore':
                        logger.debug(`[zync] push:missing-remote:${missingStrategy} stateKey=${stateKey} id=${item.id}`);
                        break;

                    default:
                        logger.error(`[zync] push:missing-remote:unknown-strategy stateKey=${stateKey} id=${item.id} strategy=${missingStrategy}`);
                        break;
                }

                removeFromPendingChanges(set, localId, stateKey);
                // Call hook so userland can alert the user etc.
                onMissingRemoteRecordDuringUpdate?.(missingStrategy, item);
            }
            break;
        }

        case SyncAction.Create: {
            const result = await api.add(changes);
            if (result) {
                logger.debug(`[zync] push:create:success stateKey=${stateKey} localId=${localId} id=${id}`);

                // Merge server-assigned fields (id, updated_at, etc) directly into local entity
                set((s: any) => ({
                    [stateKey]: (s[stateKey] || []).map((i: any) => (i._localId === localId ? { ...i, ...result } : i)),
                }));

                if (samePendingVersion(get, stateKey, localId, version)) {
                    removeFromPendingChanges(set, localId, stateKey);
                } else {
                    // Item changed during request, ensure any pendingChanges entry has id and is now an Update
                    setPendingChangeToUpdate(get, stateKey, localId, result.id);
                }

                const finalItem = { ...changes, ...result, _localId: localId };

                // Call hook so userland can perform any cascading adjustments
                onAfterRemoteAdd?.(set, get, setAndQueueToSync, stateKey, finalItem);
            } else {
                logger.warn(`[zync] push:create:no-result stateKey=${stateKey} localId=${localId} id=${id}`);
                if (samePendingVersion(get, stateKey, localId, version)) {
                    removeFromPendingChanges(set, localId, stateKey);
                }
            }
            break;
        }
    }
}
