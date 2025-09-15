import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import { waitUntil } from '../helpers/testUtils';

import { type UseStoreWithSync, createWithSync, persistWithSync } from '../../src/index';
import { storageMatrix } from '../helpers/storageMatrix';

import { installDeterministicUUID, resetDeterministicUUID } from '../helpers/testUtils';

installDeterministicUUID();

interface Fish {
    id?: number;
    _localId: string;
    name: string;
    updated_at: string;
    deleted?: boolean;
}
interface StoreState {
    fish: Fish[];
    addFish: (name: string) => void;
    updateFish: (localId: string, changes: Partial<Fish>) => void;
    removeFish: (localId: string) => void;
}

type ServerRecord = {
    id: number;
    name: string;
    updated_at: string;
    deleted?: boolean;
};

function makeApis() {
    let idCounter = 0;
    const server: ServerRecord[] = [];
    return {
        server,
        apis: {
            fish: {
                add: vi.fn(async (item: any) => {
                    const rec = {
                        id: ++idCounter,
                        ...item,
                        updated_at: new Date().toISOString(),
                    };
                    server.push(rec);
                    return { id: rec.id };
                }),
                update: vi.fn(async (id: number, changes: any) => {
                    const rec = server.find((r) => r.id === id);
                    if (rec) {
                        Object.assign(rec, changes, {
                            updated_at: new Date().toISOString(),
                        });
                        return true;
                    }
                    return false;
                }),
                remove: vi.fn(async (id: number) => {
                    const rec = server.find((r) => r.id === id);
                    if (rec) rec.deleted = true;
                }),
                list: vi.fn(async (lastUpdatedAt: Date) => {
                    return server.filter((r) => new Date(r.updated_at) > lastUpdatedAt);
                }),
                firstLoad: vi.fn(async (_lastId: any) => []),
            },
        },
    } as const;
}

function buildStore(apis: any, storage: any, syncInterval = 50, minLogLevel: any = 'debug') {
    return createWithSync<StoreState>(
        (set, get, setAndSync) => ({
            fish: [],
            addFish: (name: string) => {
                const localId = crypto.randomUUID();
                const changes = {
                    _localId: localId,
                    name,
                    updated_at: new Date().toISOString(),
                };

                setAndSync({
                    fish: [...get().fish, changes],
                });
            },
            updateFish: (localId, changes) => {
                setAndSync({
                    fish: get().fish.map((f: any) => (f._localId === localId ? { ...f, ...changes, updated_at: new Date().toISOString() } : f)),
                });
            },
            removeFish: (localId) => {
                setAndSync({
                    fish: get().fish.filter((f: any) => f._localId !== localId),
                });
            },
        }),
        { name: 'store', storage },
        apis,
        { syncInterval, minLogLevel, logger: console },
        //),
    );
}

function buildStoreWithoutHelper(apis: any, storage: any, syncInterval = 50, minLogLevel: any = 'debug') {
    return create<any>()(
        persistWithSync<StoreState>(
            (set, get, setAndSync) => ({
                fish: [],
                addFish: (name: string) => {
                    const localId = crypto.randomUUID();
                    const changes = {
                        _localId: localId,
                        name,
                        updated_at: new Date().toISOString(),
                    };

                    setAndSync({
                        fish: [...get().fish, changes],
                    });
                },
                updateFish: (localId, changes) => {
                    setAndSync({
                        fish: get().fish.map((f: any) => (f._localId === localId ? { ...f, ...changes, updated_at: new Date().toISOString() } : f)),
                    });
                },
                removeFish: (localId) => {
                    setAndSync({
                        fish: get().fish.filter((f: any) => f._localId !== localId),
                    });
                },
            }),
            { name: 'store', storage },
            apis,
            { syncInterval, minLogLevel, logger: console },
        ),
    ) as UseStoreWithSync<StoreState>;
}

describe.each(storageMatrix)('persistWithSync basic flow (%s)', ({ make }) => {
    beforeEach(() => {
        resetDeterministicUUID();
    });

    it('adds local fish and syncs to server assigning server id (without helper)', async () => {
        const { apis } = makeApis();
        const store = buildStoreWithoutHelper(apis, make());
        await waitUntil(() => store.persist.hasHydrated());
        store.sync.enable(true);
        store.getState().addFish('nemo');
        await waitUntil(() => apis.fish.add.mock.calls.length >= 1);
        await waitUntil(() => !!store.getState().fish[0]?.id);
        store.sync.enable(false);
        const s = store.getState();
        expect(s.fish[0]?.id).toBeDefined();
        expect(apis.fish.add).toHaveBeenCalled();
    });

    it('adds local fish and syncs to server assigning server id (with helper)', async () => {
        const { apis } = makeApis();
        const store = await buildStore(apis, make());
        store.sync.enable(true);
        store.getState().addFish('nemo');
        await waitUntil(() => apis.fish.add.mock.calls.length >= 1);
        await waitUntil(() => !!store.getState().fish[0]?.id);
        store.sync.enable(false);
        const s = store.getState();
        expect(s.fish[0]?.id).toBeDefined();
        expect(apis.fish.add).toHaveBeenCalled();
    });

    it('updates an existing synced fish eventually reflected on server', async () => {
        const { apis, server } = makeApis();
        const store = await buildStore(apis, make());
        store.sync.enable(true);
        store.getState().addFish('one');
        await waitUntil(() => !!store.getState().fish[0]);
        const localId = store.getState().fish[0]!._localId;
        store.getState().updateFish(localId, { name: 'two' });
        await waitUntil(() => server[0]?.name === 'two');
        store.sync.enable(false);
        expect(server[0]?.name).toBe('two');
        // update may be coalesced into initial add; only assert server state
    });

    it('removes a synced fish and marks deleted on server', async () => {
        const { apis, server } = makeApis();
        const store = await buildStore(apis, make());
        store.sync.enable(true);
        store.getState().addFish('gone');
        await waitUntil(() => !!store.getState().fish[0]);
        const localId = store.getState().fish[0]!._localId;
        store.getState().removeFish(localId);
        await waitUntil(() => store.getState().fish.length === 0 || server[0]?.deleted === true, 800);
        store.sync.enable(false);
        if (server.length) expect(server[0]?.deleted).toBe(true);
        expect(store.getState().fish.length).toBe(0);
    });

    it("update then remove a synced fish which doesn't resurrect it on pull", async () => {
        const { apis, server } = makeApis();
        const store = await buildStore(apis, make());
        store.sync.enable(true);
        store.getState().addFish('one');
        await waitUntil(() => !!store.getState().fish[0]?.id);
        expect(store.getState().fish[0]?.id).toBe(1);
        expect(server[0]?.name).toBe('one');
        // the client and server have a synced fish now
        const localId = store.getState().fish[0]!._localId;
        store.getState().updateFish(localId, { name: 'two' });
        store.getState().removeFish(localId);
        await waitUntil(() => {
            if (store.getState().fish.length > 0) {
                throw new Error('fish was resurrected');
            }
            return false;
        }, 1000);
        store.sync.enable(false);
        expect(server[0]?.deleted).toBe(true);
        expect(store.getState().fish.length).toBe(0);
    });

    it('omits sync fields (id,_localId,updated_at,deleted) from add and update payloads', async () => {
        const { apis } = makeApis();
        const store = await buildStore(apis, make());
        store.sync.enable(true);
        store.getState().addFish('payload');
        await waitUntil(() => apis.fish.add.mock.calls.length >= 1);
        // Verify add() payload
        const addArg = apis.fish.add.mock.calls[0]?.[0];
        expect(addArg.id).toBeUndefined();
        expect(addArg._localId).toBeUndefined();
        expect(addArg.updated_at).toBeUndefined();
        expect(addArg.deleted).toBeUndefined();

        const localId = store.getState().fish[0]!._localId;
        // Intentionally include sync fields in update changes
        store.getState().updateFish(localId, {
            name: 'payload2',
            id: 999,
            updated_at: 'fake',
            deleted: true,
        } as any);
        await waitUntil(() => apis.fish.update.mock.calls.length >= 1);
        store.sync.enable(false);
        const updateArg = apis.fish.update.mock.calls[0]?.[1];
        expect(updateArg.id).toBeUndefined();
        expect(updateArg._localId).toBeUndefined();
        expect(updateArg.updated_at).toBeUndefined();
        expect(updateArg.deleted).toBeUndefined();
        expect(updateArg.name).toBe('payload2');
    });
});
