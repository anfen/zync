import { removeFromPendingChanges, omitSyncFields, samePendingVersion } from './helpers';
import { MissingRemoteRecordStrategy, SyncAction } from './index';
import type { AfterRemoteAddCallback, ApiFunctions, MissingRemoteRecordDuringUpdateCallback } from './types';

const SYNC_FIELDS = ['id', '_localId', 'updated_at', 'deleted'] as const;

export async function pushOne(
    set: any,
    get: any,
    change: any,
    api: ApiFunctions,
    logger: any,
    queueToSync: any,
    missingStrategy: MissingRemoteRecordStrategy,
    onMissingRemoteRecordDuringUpdate?: MissingRemoteRecordDuringUpdateCallback,
    onAfterRemoteAdd?: AfterRemoteAddCallback,
) {
    logger.debug(`[zync] push:attempt action=${change.action} stateKey=${change.stateKey} localId=${change.localId}`);

    const { action, stateKey, localId, id, version } = change;

    switch (action) {
        case SyncAction.Remove:
            await api.remove(id);
            logger.debug(`[zync] push:remove:success ${stateKey} ${localId} ${id}`);
            removeFromPendingChanges(set, localId, stateKey);
            break;

        case SyncAction.CreateOrUpdate: {
            const state = get();
            const items: any[] = state[stateKey] || [];
            const item = items.find((i) => i._localId === localId);
            if (!item) {
                logger.warn(`[zync] push:create-or-update:no-local-item`, {
                    stateKey,
                    localId,
                });
                removeFromPendingChanges(set, localId, stateKey);
                return;
            }

            const omittedItem = omitSyncFields(item, SYNC_FIELDS);
            if (item.id) {
                // Update
                const changed = await api.update(item.id, omittedItem);
                if (changed) {
                    logger.debug('[zync] push:update:success', {
                        stateKey,
                        localId,
                        id: item.id,
                    });
                    if (samePendingVersion(get, stateKey, localId, version)) {
                        removeFromPendingChanges(set, localId, stateKey);
                    }
                    return;
                } else {
                    logger.warn('[zync] push:update:missing-remote', {
                        stateKey,
                        localId,
                        id: item.id,
                    });

                    switch (missingStrategy) {
                        case MissingRemoteRecordStrategy.DeleteLocalRecord:
                            set((s: any) => ({
                                [stateKey]: (s[stateKey] || []).filter((i: any) => i._localId !== localId),
                            }));
                            break;

                        case MissingRemoteRecordStrategy.InsertRemoteRecord: {
                            omittedItem._localId = crypto.randomUUID();
                            omittedItem.updated_at = new Date().toISOString();

                            // replace old with new copy without id so it becomes a Create
                            set((s: any) => ({
                                [stateKey]: (s[stateKey] || []).map((i: any) => (i._localId === localId ? omittedItem : i)),
                            }));

                            queueToSync(SyncAction.CreateOrUpdate, stateKey, omittedItem._localId);
                            break;
                        }
                    }
                    removeFromPendingChanges(set, localId, stateKey);
                    // Call hook so userland can alert the user etc.
                    onMissingRemoteRecordDuringUpdate?.(missingStrategy, omittedItem, omittedItem._localId);
                }
                return;
            }

            // Create
            const result = await api.add(omittedItem);
            if (result) {
                logger.debug('[zync] push:create:success', {
                    stateKey,
                    localId,
                    id: result.id,
                });

                // Merge server-assigned fields (id, updated_at, etc) directly into local entity
                set((s: any) => ({
                    [stateKey]: (s[stateKey] || []).map((i: any) => (i._localId === localId ? { ...i, ...result } : i)),
                }));
                if (samePendingVersion(get, stateKey, localId, version)) {
                    removeFromPendingChanges(set, localId, stateKey);
                }
                // Call hook so userland can perform any cascading adjustments
                onAfterRemoteAdd?.(set, get, queueToSync, stateKey, {
                    ...item,
                    ...result,
                });
            } else {
                logger.warn('[zync] push:create:no-result', {
                    stateKey,
                    localId,
                });
                if (samePendingVersion(get, stateKey, localId, version)) {
                    removeFromPendingChanges(set, localId, stateKey);
                }
            }
            break;
        }
    }
}
