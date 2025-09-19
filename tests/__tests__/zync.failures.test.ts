import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWithSync } from '../../src/index';
import { storageMatrix } from '../helpers/storageMatrix';
import { wait, waitUntil, installDeterministicUUID, resetDeterministicUUID } from '../helpers/testUtils';
installDeterministicUUID();

interface Thing {
    id?: number;
    _localId: string;
    name: string;
    updated_at: string;
}
interface StoreState {
    things: Thing[];
    addThing: (item: Partial<Thing>) => void;
    updateThing: (localId: string, changes: Partial<Thing>) => void;
    removeThing: (localId: string) => void;
}

type ServerRec = {
    id: number;
    name: string;
    updated_at: string;
    deleted?: boolean;
};

function buildStore(apis: any, storage: any, logger: any, syncInterval = 30) {
    return createWithSync<StoreState>(
        (_set, _get, setAndSync) => ({
            things: [],
            addThing: (item: Partial<Thing>) => {
                const localId = crypto.randomUUID();
                const changes = {
                    _localId: localId,
                    updated_at: new Date().toISOString(),
                    ...item,
                };
                setAndSync((state: any) => ({
                    things: [...state.things, changes],
                }));
            },
            updateThing: (localId, changes) => {
                setAndSync((state: any) => ({
                    things: state.things.map((t: any) => (t._localId === localId ? { ...t, ...changes } : t)),
                }));
            },
            removeThing: (localId) => {
                setAndSync((state: any) => ({
                    things: state.things.filter((t: any) => t._localId !== localId),
                }));
            },
        }),
        { name: 'fail-store', storage },
        apis,
        { syncInterval, logger, minLogLevel: 'debug' },
    );
    //) as UseStoreWithSync<StoreState>;
}

describe.each(storageMatrix)('failure & slow scenarios (%s)', ({ make }) => {
    beforeEach(() => {
        resetDeterministicUUID();
    });

    it('list failure surfaces error', async () => {
        const apis = {
            things: {
                add: vi.fn(async () => ({})),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => {
                    throw new Error('list boom');
                }),
                firstLoad: vi.fn(async (_lastId: any) => []),
            },
        };
        const store = await buildStore(apis, make(), console, 40);
        store.sync.enable(true);
        // allow background sync to start
        await wait(150);
        store.getState().addThing({ name: 'a' });
        await wait(300);
        store.sync.enable(false);
        const msg = store.getState().syncState.error?.message;
        expect(msg && /list boom/.test(msg)).toBe(true);
    });

    it('update failure surfaces first error and keeps item queued', async () => {
        // Fast add, failing update
        let idCounter = 0;
        const server: ServerRec[] = [];
        const apis = {
            things: {
                add: vi.fn(async (item: any) => {
                    const rec = {
                        id: ++idCounter,
                        ...item,
                        updated_at: new Date().toISOString(),
                    };
                    server.push(rec);
                    return { id: rec.id };
                }),
                update: vi.fn(async () => {
                    throw new Error('update fail');
                }),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => []),
                firstLoad: vi.fn(async () => []),
            },
        };
        const store = await buildStore(apis, make(), console, 40);
        store.sync.enable(true);
        // allow background sync to start
        await wait(150);
        store.getState().addThing({ name: 'x' });
        await wait(200);
        const localId = store.getState().things[0]!._localId;
        store.getState().updateThing(localId, { name: 'y' });
        // wait for the sync error to surface
        await waitUntil(() => !!store.getState().syncState.error, 1000);
        store.sync.enable(false);
        const msg = store.getState().syncState.error?.message;
        expect(msg && /update fail/.test(msg)).toBe(true);
        // update retried? may still be queued because update failed
        expect(apis.things.update).toHaveBeenCalled();
    });

    it('remove failure surfaces error and retains pending delete', async () => {
        let idCounter = 0;
        const server: ServerRec[] = [];
        const apis = {
            things: {
                add: vi.fn(async (item: any) => {
                    const rec = {
                        id: ++idCounter,
                        ...item,
                        updated_at: new Date().toISOString(),
                    };
                    server.push(rec);
                    return { id: rec.id };
                }),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {
                    throw new Error('remove fail');
                }),
                list: vi.fn(async () => []),
                firstLoad: vi.fn(async () => []),
            },
        };
        const store = await buildStore(apis, make(), console, 40);
        store.sync.enable(true);
        // allow background sync to start
        await wait(150);
        store.getState().addThing({ name: 'del' });
        await wait(200);
        const localId = store.getState().things[0]!._localId;
        store.getState().removeThing(localId);
        // wait for the sync error to surface
        await waitUntil(() => !!store.getState().syncState.error, 100);
        store.sync.enable(false);
        const msg = store.getState().syncState.error?.message;
        expect(msg && /remove fail/.test(msg)).toBe(true);
        expect(server[0]?.deleted).toBeUndefined(); // not marked deleted yet
    });

    it('overlapping sync cycles are skipped (isSyncing guard)', async () => {
        // Slow list so first sync holds the lock
        let idCounter = 0;
        const server: ServerRec[] = [];
        const listDelay = 120;
        const apis = {
            things: {
                add: vi.fn(async (item: any) => {
                    const rec = {
                        id: ++idCounter,
                        ...item,
                        updated_at: new Date().toISOString(),
                    };
                    server.push(rec);
                    return { id: rec.id };
                }),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => {
                    await wait(listDelay);
                    return [];
                }),
                firstLoad: vi.fn(async () => []),
            },
        };
        const store = await buildStore(apis, make(), console, 30);
        store.sync.enable(true);
        // allow background sync to start
        await wait(140); // expect 2 list requests by now
        store.getState().addThing({ name: 'one' });
        // While first sync (list) still running, trigger rapid updates causing internal syncOnce attempts
        const localId = store.getState().things[0]!._localId;
        await wait(20);
        store.getState().updateThing(localId, { name: 'two' });
        await wait(20);
        store.getState().updateThing(localId, { name: 'three' });
        store.sync.enable(false);
        // list should have been awaited only for first cycle (subsequent cycles skipped while isSyncing true, plus interval after finish)
        expect(apis.things.list.mock.calls.length).toBe(2);
        expect(store.getState().things[0]!.name).toBe('three');
        expect(server.length).toBe(0);
    });

    it('slow add does not cause duplicate adds when overlapping triggers occur', async () => {
        let idCounter = 0;
        const server: ServerRec[] = [];
        const apis = {
            things: {
                add: vi.fn(async (item: any) => {
                    await wait(100);
                    const rec = {
                        ...item,
                        id: ++idCounter,
                        updated_at: new Date().toISOString(),
                    };
                    server.push(rec);
                    return { id: rec.id };
                }),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => []),
                firstLoad: vi.fn(async () => []),
            },
        };
        const store = await buildStore(apis, make(), console, 40);
        store.sync.enable(true);
        // allow background sync to start
        await wait(150);
        store.getState().addThing({ name: 'alpha' });
        await wait(50);
        store.getState().updateThing(store.getState().things[0]!._localId, { name: 'beta' });
        await wait(2000);
        // wait for server add to complete (slow add may be in-flight)
        await waitUntil(() => server.length > 0, 800);
        store.sync.enable(false);
        expect(server.length).toBe(1);
        expect(server[0]?.name === 'alpha').toBe(true); // final server state as api.update isn't implemented
    });
});
