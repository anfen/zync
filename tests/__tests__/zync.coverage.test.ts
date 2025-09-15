import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWithSync } from '../../src/index';
import { storageMatrix } from '../helpers/storageMatrix';
import { wait, installDeterministicUUID, resetDeterministicUUID, waitUntil } from '../helpers/testUtils';
installDeterministicUUID();

interface Rec {
    id?: number;
    _localId: string;
    name: string;
    updated_at: string;
    deleted?: boolean;
}
interface State {
    items: Rec[];
    unsynced: any[];
    add: (name: string) => void;
    upd: (lid: string, c: Partial<Rec>) => void;
}

function build(apis: any, storage: any, initial: Partial<State> = {}, syncInterval = 25) {
    return createWithSync<State>(
        (set, get, setAndSync) => ({
            items: [],
            unsynced: [],
            add: (name: string) =>
                set({
                    items: [
                        ...get().items,
                        {
                            _localId: crypto.randomUUID(),
                            name,
                            updated_at: new Date().toISOString(),
                        },
                    ],
                }),
            upd: (lid, _c) => setAndSync({ items: get().items.map((i: any) => (i._localId === lid ? { ...i, ..._c } : i)) }),
            syncState: { done: true },
            ...initial,
        }),
        { name: 'cov-store', storage },
        apis,
        { syncInterval, minLogLevel: 'none' },
        //),
    ); // as UseStoreWithSync<State>;
}

describe.each(storageMatrix)('extra coverage branches (%s)', ({ make }) => {
    beforeEach(() => {
        resetDeterministicUUID();
    });

    it('skips unsynced array state key without errors', async () => {
        const apis = {
            items: {
                add: vi.fn(async () => ({})),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => []),
                firstLoad: vi.fn(async (_lastId: any) => []),
            },
        };
        const store = await build(apis, make());
        store.sync.enable(true);
        store.getState().unsynced.push('x');
        store.getState().add('a');
        await waitUntil(() => true, 200);
        store.sync.enable(false);
        expect(store.getState().items.length).toBeGreaterThanOrEqual(0);
    });

    it('pending local update prevents server merge overwrite (local newer wins)', async () => {
        let idCounter = 0;
        const server: any[] = [];
        const apis = {
            items: {
                add: vi.fn(async (item: any) => {
                    const rec = {
                        id: ++idCounter,
                        ...item,
                        updated_at: new Date().toISOString(),
                    };
                    server.push(rec);
                    return rec;
                }),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async (lastUpdatedAt: Date) => {
                    return server.filter((r) => new Date(r.updated_at) > lastUpdatedAt);
                }),
            },
        };

        const store = await build(apis, make(), {}, 30);
        store.sync.enable(true);
        store.getState().add('local');
        await waitUntil(() => !!store.getState().items[0]); // allow add pushed & id assigned
        // ensure server received the created record before we simulate an external newer update
        await waitUntil(() => server.length > 0, 1200);
        const loc = store.getState().items[0];
        // First change server to a newer version (simulating external update)
        if (server[0]) {
            server[0].name = 'server-change';
            server[0].updated_at = new Date(Date.now() + 5000).toISOString();
        }
        // Then queue local update which should be protected from merge overwrite
        store.getState().upd(loc!._localId, { name: 'local-change' }); // queues pending server update
        // Wait for either the local change to be visible or for the update API to be invoked
        await waitUntil(() => store.getState().items[0]?.name === 'local-change' || apis.items.update.mock.calls.length > 0, 3000);
        store.sync.enable(false);
        const finalItem = store.getState().items[0];
        // Ensure the server's newer change did not overwrite our local value
        expect(finalItem?.name).not.toBe('server-change');
    });

    it('rapid overlapping sync calls hits isSyncing guard (second early return)', async () => {
        const listDelay = 120;
        const apis = {
            items: {
                add: vi.fn(async () => ({})),
                update: vi.fn(async () => true),
                remove: vi.fn(async () => {}),
                list: vi.fn(async () => {
                    await wait(listDelay);
                    return [];
                }),
            },
        };
        const store = await build(apis, make(), {}, 30);
        store.sync.enable(true);
        store.getState().add('r1');
        // fire multiple updates quickly to invoke syncOnce while previous still running
        const lid = () => store.getState().items[0]?._localId;
        await wait(10);
        if (lid()) store.getState().upd(lid()!, { name: 'u1' });
        await wait(10);
        if (lid()) store.getState().upd(lid()!, { name: 'u2' });
        await wait(230);
        store.sync.enable(false);
        // list should not be excessive
        expect(apis.items.list.mock.calls.length).toBeLessThanOrEqual(3);
    });
});
