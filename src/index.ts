import { create, type StateCreator } from 'zustand';
import { persist } from 'zustand/middleware';
import { newLogger, type Logger, type LogLevel } from './logger';
import { orderFor, findApi, findChanges, tryAddToPendingChanges } from './helpers';
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
import { startFirstLoad } from './firstLoad';

export { createIndexedDBStorage } from './indexedDBStorage';
export { nextLocalId } from './helpers';
export type { ApiFunctions, UseStoreWithSync, SyncState } from './types';

export enum SyncAction {
    Create = 'create',
    Update = 'update',
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

            let firstSyncError: Error | undefined;

            // 1) PULL for each stateKey
            for (const stateKey of Object.keys(syncApi)) {
                try {
                    const api = findApi(stateKey, syncApi);
                    await pull(set, get, stateKey, api, logger, conflictResolutionStrategy);
                } catch (err) {
                    firstSyncError = firstSyncError ?? (err as Error);
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
                    firstSyncError = firstSyncError ?? (err as Error);
                    logger.error(`[zync] push:error change=${change}`, err);
                }
            }

            set((state: any) => ({
                syncState: {
                    ...(state.syncState || {}),
                    status: 'idle',
                    error: firstSyncError,
                },
            }));

            if (get().syncState.pendingChanges.length > 0 && !firstSyncError) {
                // If there are pending changes and no sync error, we can sync again
                await syncOnce();
            }
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
                tryAddToPendingChanges(pendingChanges, stateKey, changes);
            });

            return {
                ...partial,
                syncState: {
                    ...(state.syncState || {}),
                    pendingChanges,
                },
            };
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
            startFirstLoad: () => startFirstLoad(set, syncApi, logger),
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
