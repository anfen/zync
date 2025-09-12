import { SyncAction } from './index';
import type { ApiFunctions, PendingChange } from './types';

export function nextLocalId(): string {
    return crypto.randomUUID();
}

export function orderFor(a: SyncAction): number {
    switch (a) {
        case SyncAction.CreateOrUpdate:
            return 1;
        case SyncAction.Remove:
            return 2;
    }
}

export function omitSyncFields(item: any, fields: readonly string[]) {
    const result = { ...item };
    for (const k of fields) delete result[k];
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

export function findApi(stateKey: string, syncApi: Record<string, ApiFunctions>) {
    const api = syncApi[stateKey];
    if (!api || !api.add || !api.update || !api.remove || !api.list || !api.firstLoad) {
        throw new Error(`Missing API function(s) for state key: ${stateKey}.`);
    }
    return api;
}
