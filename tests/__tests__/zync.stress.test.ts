import { describe, it, expect, vi } from 'vitest';

import { waitUntil, installDeterministicUUID, resetDeterministicUUID } from '../helpers/testUtils';
import { storageMatrix } from '../helpers/storageMatrix';
import { createWithSync } from '../../src/index';

installDeterministicUUID();

type Item = { id?: number; _localId: string; name: string; updated_at: string; deleted?: boolean };

function makeFaultyApis(opts: { errorRate?: number; maxDelayMs?: number } = {}) {
    const errorRate = opts.errorRate ?? 0.05;
    const maxDelay = opts.maxDelayMs ?? 30;

    // small seeded PRNG for reproducibility
    let seed = 123456789;
    function rand() {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    }

    let idCounter = 0;
    const server: Item[] = [];

    function maybeDelay() {
        const d = Math.floor(rand() * maxDelay);
        return new Promise((r) => setTimeout(r, d));
    }
    function maybeThrow(endpoint: string) {
        if (rand() < errorRate) throw new Error(`random ${endpoint} failure`);
    }

    const apis = {
        items: {
            add: vi.fn(async (item: any) => {
                await maybeDelay();
                maybeThrow('add');
                const rec = { id: ++idCounter, ...item, updated_at: new Date().toISOString() };
                server.push(rec as Item);
                return { id: rec.id, updated_at: rec.updated_at };
            }),
            update: vi.fn(async (id: number, changes: any) => {
                await maybeDelay();
                maybeThrow('update');
                const rec = server.find((r) => r.id === id);
                if (!rec) return false;
                Object.assign(rec, changes, { updated_at: new Date().toISOString() });
                return true;
            }),
            remove: vi.fn(async (id: number) => {
                await maybeDelay();
                maybeThrow('remove');
                const rec = server.find((r) => r.id === id);
                if (rec) rec.deleted = true;
            }),
            list: vi.fn(async (lastUpdatedAt: Date) => {
                await maybeDelay();
                maybeThrow('list');
                return server.filter((r) => new Date(r.updated_at) > lastUpdatedAt).map((r) => ({ ...r }));
            }),
            firstLoad: vi.fn(async (_lastId: any) => {
                await maybeDelay();
                maybeThrow('firstLoad');
                return [] as any[];
            }),
        },
    } as const;

    return { apis, server } as const;
}

function buildStressStore(apis: any, storage: any, syncInterval = 20) {
    return createWithSync<any>(
        (set: any, get: any, setAndSync: any) => ({
            items: [] as Item[],
            addItem: (name: string) => {
                const localId = crypto.randomUUID();
                const rec = { _localId: localId, name, updated_at: new Date().toISOString() };
                setAndSync({ items: [...get().items, rec] });
            },
            updateItem: (localId: string, changes: Partial<Item>) => {
                setAndSync({ items: get().items.map((i: any) => (i._localId === localId ? { ...i, ...changes, updated_at: new Date().toISOString() } : i)) });
            },
            removeItem: (localId: string) => {
                setAndSync({ items: get().items.filter((i: any) => i._localId !== localId) });
            },
        }),
        { name: 'stress-store', storage },
        apis,
        { syncInterval, minLogLevel: 'none', logger: console },
        //),
    ); // as UseStoreWithSync<{ items: Item[]; addItem: (n: string) => void; updateItem: (id: string, c: any) => void; removeItem: (id: string) => void }>;
}

describe.each(storageMatrix)('persistWithSync stress test', ({ make }) => {
    // WARNING: Long running test!!!
    it('runs thousands of interleaved operations and server/client converge', async () => {
        resetDeterministicUUID();
        const { apis, server } = makeFaultyApis({ errorRate: 0.06, maxDelayMs: 40 });
        const store = await buildStressStore(apis, make(), 15);
        store.sync.enable(true);

        const OP_COUNT = 2000; // thousands of ops
        const ops: Promise<void>[] = [];

        // Maintain a local list of current localIds for update/remove picks
        const localIds: string[] = [];

        // small seeded PRNG for operation choices
        let seed = 987654321;
        function rand() {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        }

        for (let i = 0; i < OP_COUNT; i++) {
            const delay = Math.floor(rand() * 20);
            const p = new Promise<void>((res) =>
                setTimeout(async () => {
                    try {
                        const r = rand();
                        if (r < 0.45 || localIds.length === 0) {
                            // add
                            const name = `name-${i}`;
                            store.getState().addItem(name);
                            // last added localId is deterministic via deterministic UUIDs
                            const last = store.getState().items[store.getState().items.length - 1];
                            if (last) localIds.push(last._localId);
                        } else if (r < 0.85) {
                            // update
                            const idx = Math.floor(rand() * localIds.length);
                            const lid = localIds[idx];
                            if (lid) store.getState().updateItem(lid, { name: `u-${i}` });
                        } else {
                            // remove
                            const idx = Math.floor(rand() * localIds.length);
                            const lid = localIds.splice(idx, 1)[0];
                            if (lid) store.getState().removeItem(lid);
                        }
                    } catch (_e) {
                        // ignore runtime errors in client ops
                    } finally {
                        res();
                    }
                }, delay),
            );
            ops.push(p);
        }

        // Wait for all operations to be enqueued
        await Promise.all(ops);

        // Wait until pendingChanges empty and no items lack server id
        await waitUntil(
            () => {
                const st = store.getState();
                const pending = st.syncState?.pendingChanges?.length ?? 0;
                const missingIds = st.items.some((it: any) => !it.id);
                return pending === 0 && !missingIds;
            },
            60_000,
            50,
        );

        // disable sync to stop background activity
        store.sync.enable(false);

        // Normalize server and client visible items (non-deleted)
        const serverVisible = server.filter((s) => !s.deleted).map((s) => ({ id: s.id, name: s.name }));
        const clientVisible = store.getState().items.map((i: any) => ({ id: i.id, name: i.name }));

        // Sort and compare
        const sortFn = (a: any, b: any) => a.id - b.id;
        serverVisible.sort(sortFn);
        clientVisible.sort(sortFn);

        expect(clientVisible.length).toBe(serverVisible.length);
        for (let i = 0; i < serverVisible.length; i++) {
            expect(clientVisible[i]!.id).toBe(serverVisible[i]!.id);
            expect(clientVisible[i]!.name).toBe(serverVisible[i]!.name);
        }
    }, 120_000);
});
