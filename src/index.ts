import { create, type StateCreator } from 'zustand';
import { persist } from 'zustand/middleware';
import { newLogger, type Logger, type LogLevel } from './logger';
import { orderFor, findApi, nextLocalId, findChanges, type ChangeRecord } from './helpers';
import type {
    ApiFunctions,
    SyncOptions,
    SyncState,
    SyncedStateCreator,
    PendingChange,
    UseStoreWithSync,
    MissingRemoteRecordStrategy,
    ConflictResolutionStrategy,
} from './types';
import { pull } from './pull';
import { pushOne } from './push';

export { createIndexedDBStorage } from './indexedDBStorage';
export { nextLocalId } from './helpers';
export type { ApiFunctions, UseStoreWithSync, SyncState } from './types';

export enum SyncAction {
    CreateOrUpdate = 'create-or-update',
    Remove = 'remove',
}

const DEFAULT_SYNC_INTERVAL_MILLIS = 5000;
const DEFAULT_LOGGER: Logger = console;
const DEFAULT_MIN_LOG_LEVEL: LogLevel = 'debug';
const DEFAULT_MISSING_REMOTE_RECORD_STRATEGY: MissingRemoteRecordStrategy = 'ignore';
const DEFAULT_CONFLICT_RESOLUTION_STRATEGY: ConflictResolutionStrategy = 'local-wins';

export function createWithSync<TStore extends object>(
    stateCreator: SyncedStateCreator<TStore>,
    persistOptions: any,
    syncApi: Record<string, ApiFunctions>,
    syncOptions: SyncOptions = {},
): Promise<UseStoreWithSync<TStore>> {
    const store = create(persistWithSync(stateCreator, persistOptions, syncApi, syncOptions)) as UseStoreWithSync<TStore>;

    return new Promise<UseStoreWithSync<TStore>>((resolve) => {
        store.persist.onFinishHydration((_state) => {
            resolve(store);
        });
    });
}

export function persistWithSync<TStore extends object>(
    stateCreator: SyncedStateCreator<TStore>,
    persistOptions: any,
    syncApi: Record<string, ApiFunctions>,
    syncOptions: SyncOptions = {},
) {
    const syncInterval = syncOptions.syncInterval ?? DEFAULT_SYNC_INTERVAL_MILLIS;
    const missingStrategy = syncOptions.missingRemoteRecordDuringUpdateStrategy ?? DEFAULT_MISSING_REMOTE_RECORD_STRATEGY;
    const conflictResolutionStrategy = syncOptions.conflictResolutionStrategy ?? DEFAULT_CONFLICT_RESOLUTION_STRATEGY;
    const logger = newLogger(syncOptions.logger ?? DEFAULT_LOGGER, syncOptions.minLogLevel ?? DEFAULT_MIN_LOG_LEVEL);

    const baseOnRehydrate = persistOptions?.onRehydrateStorage;
    const basePartialize = persistOptions?.partialize;

    const wrappedPersistOptions = {
        ...persistOptions,
        onRehydrateStorage: () => {
            logger.debug('[zync] rehydration:start');

            return (state: any, error: any) => {
                if (error) {
                    logger.error('[zync] rehydration:failed', error);
                } else {
                    baseOnRehydrate?.(state, error);
                    logger.debug('[zync] rehydration:complete', state);
                }
            };
        },
        partialize: (s: any) => {
            // Select state to be persisted

            const base = basePartialize ? basePartialize(s) : s;
            const { syncState, ...rest } = base || {};
            return {
                ...rest,
                syncState: {
                    firstLoadDone: syncState.firstLoadDone,
                    pendingChanges: syncState.pendingChanges,
                    lastPulled: syncState.lastPulled,
                },
            };
        },
        merge: (persisted: any, current: any) => {
            // Here after hydration.
            // `persisted` is state from storage that's just loaded (possibly asynchronously e.g. IndexedDB)
            // `current` is what the user has defined (they may have added or removed state keys)
            // Zync is designed to not be used until hydration is complete, so we don't expect to have to
            // merge user mutated state (i.e. current) into persisted. So we do the Zustand recommended pattern of
            // shallow copy where persisted keys win:
            const state = { ...current, ...persisted };

            return {
                ...state,
                syncState: {
                    ...state.syncState,
                    status: 'idle', // this confirms 'hydrating' is done
                },
            };
        },
    };

    const creator: StateCreator<TStore & SyncState, [], []> = (set: any, get: any, storeApi: any) => {
        let syncIntervalId: any;

        async function syncOnce() {
            const state: SyncState = get();
            if (!state.syncState.enabled || state.syncState.status !== 'idle') return;

            set((state: any) => ({
                syncState: {
                    ...(state.syncState || {}),
                    status: 'syncing',
                },
            }));

            let syncError: Error | undefined;

            // 1) PULL for each stateKey
            for (const stateKey of Object.keys(syncApi)) {
                try {
                    const api = findApi(stateKey, syncApi);
                    await pull(set, get, stateKey, api, logger, conflictResolutionStrategy);
                } catch (err) {
                    syncError = syncError ?? (err as Error);
                    logger.error(`[zync] pull:error stateKey=${stateKey}`, err);
                }
            }

            // 2) PUSH queued changes
            const changesSnapshot: PendingChange[] = [...(get().syncState.pendingChanges || [])];

            // Deterministic ordering: Create -> Update -> Remove so dependencies (e.g. id assignment) happen first
            changesSnapshot.sort((a, b) => orderFor(a.action) - orderFor(b.action));

            for (const change of changesSnapshot) {
                try {
                    const api = findApi(change.stateKey, syncApi);
                    await pushOne(
                        set,
                        get,
                        change,
                        api,
                        logger,
                        setAndQueueToSync,
                        missingStrategy,
                        syncOptions.onMissingRemoteRecordDuringUpdate,
                        syncOptions.onAfterRemoteAdd,
                    );
                } catch (err) {
                    syncError = syncError ?? (err as Error);
                    logger.error(`[zync] push:error change=${change}`, err);
                }
            }

            set((state: any) => ({
                syncState: {
                    ...(state.syncState || {}),
                    status: 'idle',
                    error: syncError,
                },
            }));

            if (get().syncState.pendingChanges.length > 0 && !syncError) {
                // If there are pending changes and no sync error, we can sync again
                await syncOnce();
            }
        }

        async function startFirstLoad() {
            let syncError: Error | undefined;

            for (const stateKey of Object.keys(syncApi)) {
                try {
                    logger.info(`[zync] firstLoad:start stateKey=${stateKey}`);

                    const api = findApi(stateKey, syncApi);
                    let lastId; // Start as undefined to allow the userland api code to set the initial value+type

                    // Batch until empty
                    while (true) {
                        const batch = await api.firstLoad(lastId);
                        if (!batch?.length) break;

                        // Merge batch
                        set((state: any) => {
                            const local: any[] = state[stateKey] || [];
                            const localById = new Map<any, any>(local.filter((l) => l.id).map((l) => [l.id, l]));

                            let newest = new Date(state.syncState.lastPulled[stateKey] || 0);
                            const next = [...local];
                            for (const remote of batch) {
                                const remoteUpdated = new Date(remote.updated_at || 0);
                                if (remoteUpdated > newest) newest = remoteUpdated;

                                if (remote.deleted) continue;

                                delete remote.deleted;

                                const localItem = remote.id ? localById.get(remote.id) : undefined;
                                if (localItem) {
                                    const merged = {
                                        ...localItem,
                                        ...remote,
                                        _localId: localItem._localId,
                                    };
                                    const idx = next.findIndex((i) => i._localId === localItem._localId);
                                    if (idx >= 0) next[idx] = merged;
                                } else {
                                    next.push({
                                        ...remote,
                                        _localId: nextLocalId(),
                                    });
                                }
                            }

                            return {
                                [stateKey]: next,
                                syncState: {
                                    ...(state.syncState || {}),
                                    lastPulled: {
                                        ...(state.syncState.lastPulled || {}),
                                        [stateKey]: newest.toISOString(),
                                    },
                                },
                            };
                        });

                        lastId = batch[batch.length - 1].id;
                    }

                    logger.info(`[zync] firstLoad:done stateKey=${stateKey}`);
                } catch (err) {
                    syncError = syncError ?? (err as Error);
                    logger.error(`[zync] firstLoad:error stateKey=${stateKey}`, err);
                }
            }

            set((state: any) => ({
                syncState: {
                    ...(state.syncState || {}),
                    firstLoadDone: true,
                    error: syncError,
                },
            }));
        }

        function setAndSyncOnce(partial: any) {
            if (typeof partial === 'function') {
                set((state: any) => ({ ...partial(state) }));
            } else {
                set(partial);
            }
            syncOnce();
        }

        function setAndQueueToSync(partial: any) {
            if (typeof partial === 'function') {
                set((state: any) => newSyncState(state, partial(state)));
            } else {
                set((state: any) => newSyncState(state, partial));
            }
            syncOnce();
        }

        function newSyncState(state: any, partial: any) {
            const pendingChanges: PendingChange[] = state.syncState.pendingChanges || [];

            Object.keys(partial).map((stateKey) => {
                const current = state[stateKey];
                const updated = partial[stateKey];
                const changes = findChanges(current, updated); // find additions, deletions & updates
                addToPendingChanges(pendingChanges, stateKey, changes);
            });

            return {
                ...partial,
                syncState: {
                    ...(state.syncState || {}),
                    pendingChanges,
                },
            };
        }

        function addToPendingChanges(pendingChanges: PendingChange[], stateKey: string, changes: Map<string, ChangeRecord>) {
            for (const [localId, change] of changes) {
                const action = change.updatedItem === null ? SyncAction.Remove : SyncAction.CreateOrUpdate;

                const queueItem = pendingChanges.find((p) => p.localId === localId && p.stateKey === stateKey);
                if (queueItem) {
                    queueItem.version += 1;

                    if (queueItem.action === SyncAction.CreateOrUpdate && action === SyncAction.Remove && change.currentItem.id) {
                        queueItem.action = SyncAction.Remove;
                        queueItem.id = change.currentItem.id;
                        logger.debug(`[zync] addToPendingChanges:changed-to-remove action=${action} localId=${localId} v=${queueItem.version}`);
                    } else {
                        logger.debug(`[zync] addToPendingChanges:re-queued action=${action} localId=${localId} v=${queueItem.version}`);
                    }
                } else {
                    pendingChanges.push({ action, stateKey, localId, id: change.currentItem?.id, version: 1 });
                    logger.debug(`[zync] addToPendingChanges:added action=${action} localId=${localId}`);
                }
            }
        }

        function enable(enabled: boolean) {
            set((state: any) => ({
                syncState: {
                    ...(state.syncState || {}),
                    enabled,
                },
            }));

            enableSyncTimer(enabled);
            addVisibilityChangeListener(enabled);
        }

        function enableSyncTimer(enabled: boolean) {
            clearInterval(syncIntervalId);
            syncIntervalId = undefined;
            if (enabled) {
                syncIntervalId = setInterval(syncOnce, syncInterval);
                syncOnce();
            }
        }

        function addVisibilityChangeListener(add: boolean) {
            if (add) {
                document.addEventListener('visibilitychange', onVisibilityChange);
            } else {
                document.removeEventListener('visibilitychange', onVisibilityChange);
            }
        }

        function onVisibilityChange() {
            if (document.visibilityState === 'visible') {
                logger.debug('[zync] sync:start-in-foreground');
                enableSyncTimer(true);
            } else {
                logger.debug('[zync] sync:pause-in-background');
                enableSyncTimer(false);
            }
        }

        // public useStore.sync api, similar in principle to useStore.persist
        storeApi.sync = {
            enable,
            startFirstLoad,
        };

        const userState = stateCreator(setAndSyncOnce, get, setAndQueueToSync) as TStore;

        return {
            ...userState,
            syncState: {
                // set defaults
                status: 'hydrating',
                error: undefined,
                enabled: false,
                firstLoadDone: false,
                pendingChanges: [],
                lastPulled: {},
            },
        } as TStore & SyncState;
    };

    return persist(creator, wrappedPersistOptions);
}
