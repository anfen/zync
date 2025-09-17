import { findApi, nextLocalId } from './helpers';
import type { Logger } from './logger';
import type { ApiFunctions } from './types';

export async function startFirstLoad(set: any, syncApi: Record<string, ApiFunctions>, logger: Logger) {
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

                if (lastId !== undefined && lastId === batch[batch.length - 1].id) {
                    throw new Error(`Duplicate records downloaded, stopping to prevent infinite loop`);
                }

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
