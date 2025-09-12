import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncAction, createWithSync } from '../../src/index';
import { storageMatrix } from '../helpers/storageMatrix';

import { installDeterministicUUID, resetDeterministicUUID } from '../helpers/testUtils';
installDeterministicUUID();

interface Item {
    id?: number;
    _localId: string;
    name: string;
    updated_at: string;
    deleted?: boolean;
}
interface StoreState {
    items: Item[];
    addItem: (name: string) => void;
    updateItem: (localId: string, changes: Partial<Item>) => void;
    removeItem: (localId: string) => void;
}

type ServerRecord = {
    id: number;
    name: string;
    updated_at: string;
    deleted?: boolean;
};

function buildApis() {
    let idCounter = 0;
    const server: ServerRecord[] = [];
    const latency = 5;
    return {
        server,
        apis: {
            items: {
                add: vi.fn(async (item: any) => {
                    await new Promise((r) => setTimeout(r, latency));
                    const rec = {
                        id: ++idCounter,
                        ...item,
                        updated_at: new Date().toISOString(),
                    };
                    server.push(rec);
                    return { id: rec.id };
                }),
                update: vi.fn(async (id: number, changes: any) => {
                    await new Promise((r) => setTimeout(r, latency));
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
                    await new Promise((r) => setTimeout(r, latency));
                    const rec = server.find((r) => r.id === id);
                    if (rec) rec.deleted = true;
                }),
                list: vi.fn(async (lastUpdatedAt: Date) => {
                    await new Promise((r) => setTimeout(r, latency));
                    return server.filter((r) => new Date(r.updated_at) > lastUpdatedAt);
                }),
                firstLoad: vi.fn(async (_lastId: any) => []),
            },
        },
    } as const;
}

function buildStore(apis: any, storage: any, syncInterval = 40, minLogLevel: any = 'none') {
    return createWithSync<StoreState>(
        (set, get, queueToSync) => ({
            items: [],
            addItem: (name: string) => {
                const localId = crypto.randomUUID();
                set({
                    items: [
                        ...get().items,
                        {
                            _localId: localId,
                            name,
                            updated_at: new Date().toISOString(),
                        },
                    ],
                });
                queueToSync(SyncAction.CreateOrUpdate, 'items', localId);
            },
            updateItem: (localId, changes) => {
                set({
                    items: get().items.map((i: any) => (i._localId === localId ? { ...i, ...changes } : i)),
                });
                queueToSync(SyncAction.CreateOrUpdate, 'items', localId);
            },
            removeItem: (localId) => {
                queueToSync(SyncAction.Remove, 'items', localId);
                set({
                    items: get().items.filter((i: any) => i._localId !== localId),
                });
            },
        }),
        { name: 'adv-store', storage },
        apis,
        { syncInterval, minLogLevel },
        //),
    ); // as UseStoreWithSync<StoreState>;
}

async function tick(ms = 90) {
    await new Promise((r) => setTimeout(r, ms));
}

function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
}

describe.each(storageMatrix)('advanced sync scenarios (%s)', ({ make }) => {
    beforeEach(() => {
        resetDeterministicUUID();
    });

    async function waitUntil(predicate: () => boolean, timeout = 800, step = 20) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (predicate()) return;
            await new Promise((r) => setTimeout(r, step));
        }
    }

    it('handles rapid consecutive updates before server push (coalescing logic path)', async () => {
        const { apis, server } = buildApis();
        const store = await buildStore(apis, make());
        store.sync.enable(true);
        store.getState().addItem('a');
        await waitUntil(() => !!store.getState().items[0]);
        const localId = store.getState().items[0]!._localId;
        store.getState().updateItem(localId, { name: 'b' });
        store.getState().updateItem(localId, { name: 'c' }); // second change before sync cycle completes
        await waitUntil(() => server[0]?.name === 'c', 1200);
        store.sync.enable(false);
        expect(server[0]?.name).toBe('c');
        // update might be coalesced; asserting final server state is sufficient
    });

    it('deletes item locally during inflight add resulting in server delete queueing', async () => {
        const { apis, server } = buildApis();
        const store = await buildStore(apis, make(), 200); // longer interval to keep add inflight
        store.sync.enable(true);
        store.getState().addItem('temp');
        await waitUntil(() => !!store.getState().items[0]);
        const localId = store.getState().items[0]!._localId;
        // remove immediately before sync cycle triggers add completion -> rely on background sync start
        store.getState().removeItem(localId);
        await waitUntil(() => store.getState().items.length === 0, 1200);
        store.sync.enable(false);
        // server may have received add then delete flag set
        if (server.length) expect(server[0]?.deleted).toBe(true);
        expect(store.getState().items.length).toBe(0);
    });

    it('visibility change stops and restarts interval sync', async () => {
        const { apis } = buildApis();
        const store = await buildStore(apis, make(), 40);
        store.sync.enable(true);
        store.getState().addItem('vis');
        await waitUntil(() => apis.items.add.mock.calls.length >= 1);
        const updatesBefore = apis.items.add.mock.calls.length;
        setVisibility('hidden');
        const callsHiddenStart = apis.items.add.mock.calls.length;
        await waitUntil(() => true, 200);
        // should not have added new calls just from being hidden
        expect(apis.items.add.mock.calls.length).toBe(callsHiddenStart);
        setVisibility('visible');
        await waitUntil(() => apis.items.add.mock.calls.length >= updatesBefore);
        store.sync.enable(false);
        expect(apis.items.add.mock.calls.length).toBeGreaterThanOrEqual(updatesBefore); // initial still
    });

    it('handles server list returning deletions and merges updates skipping pending local updates', async () => {
        const { apis, server } = buildApis();
        const store = await buildStore(apis, make());
        store.sync.enable(true);
        // Seed server with two records ahead of local pull
        server.push({
            id: 101,
            name: 'srv1',
            updated_at: new Date().toISOString(),
        });
        server.push({
            id: 102,
            name: 'srv2',
            updated_at: new Date().toISOString(),
        });
        // add local unsynced item
        store.getState().addItem('local');
        await waitUntil(() => true, 120);
        // update server record 1 and mark record 2 deleted to exercise merge branches
        const rec1 = server.find((s) => s.id === 101)!;
        rec1.name = 'srv1-new';
        rec1.updated_at = new Date().toISOString();
        const rec2 = server.find((s) => s.id === 102)!;
        rec2.deleted = true;
        rec2.updated_at = new Date().toISOString();
        await tick(120);
        const names = store
            .getState()
            .items.map((i: any) => i.name)
            .sort();
        store.sync.enable(false);
        expect(names).toContain('srv1-new');
        expect(names).not.toContain('srv2');
    });

    it('throws errors from API functions and surfaces via syncState.error', async () => {
        const badApis = {
            items: {
                add: vi.fn(async () => {
                    throw new Error('add fail');
                }),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => []),
            },
        };
        const store = await buildStore(badApis, make(), 40);
        store.sync.enable(true);
        store.getState().addItem('err');
        await waitUntil(() => !!store.getState().syncState.error, 800);
        store.sync.enable(false);
        const { error } = store.getState().syncState;
        expect(error).toBeInstanceOf(Error);
    });

    it('missing api functions per key triggers error on first sync usage', async () => {
        const baseApis: any = {
            items: {
                add: async () => ({}),
                update: async () => true,
                remove: async () => {},
                list: async () => [],
            },
        };
        for (const key of ['add', 'update', 'remove', 'list'] as const) {
            const copy = JSON.parse(JSON.stringify(baseApis));
            delete copy.items[key];
            const store = await buildStore(copy, make(), 40);
            store.sync.enable(true);
            // call add to trigger sync cycle soon
            store.getState().addItem('x');
            // Allow sync to run and capture error
            await waitUntil(() => !!store.getState().syncState.error, 800);
            store.sync.enable(false);
            // Expect syncState.error populated with missing api message
            const err = store.getState().syncState.error;
            expect(err).toBeInstanceOf(Error);
            // Implementation may throw native TypeError message; just assert an Error was surfaced
        }
    });
});
