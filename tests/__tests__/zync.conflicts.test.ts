import { describe, expect, it, beforeEach, vi } from 'vitest';

import { createWithSync } from '../../src/index';
import { storageMatrix } from '../helpers/storageMatrix';
import { installDeterministicUUID, resetDeterministicUUID } from '../helpers/testUtils';

installDeterministicUUID();

describe.each(storageMatrix)('conflict resolution (%s)', ({ make }) => {
    beforeEach(() => {
        resetDeterministicUUID();
    });

    function buildApis() {
        let idCounter = 0;
        const server: any[] = [];
        const latency = 5;
        return {
            server,
            apis: {
                items: {
                    add: vi.fn(async (item: any) => {
                        await new Promise((r) => setTimeout(r, latency));
                        const rec = { id: ++idCounter, ...item, updated_at: new Date().toISOString() };
                        server.push(rec);
                        return { id: rec.id };
                    }),
                    update: vi.fn(async (id: number, changes: any) => {
                        await new Promise((r) => setTimeout(r, latency));
                        const rec = server.find((r) => r.id === id);
                        if (rec) {
                            Object.assign(rec, changes, { updated_at: new Date().toISOString() });
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

    function buildStore(apis: any, storage: any, conflictStrategy: any) {
        return createWithSync<any>(
            (_set, get, setAndSync) => ({
                items: [],
                addItem: (name: string) => {
                    const localId = crypto.randomUUID();
                    setAndSync({
                        items: [...get().items, { _localId: localId, name, updated_at: new Date().toISOString() }],
                    });
                },
                updateItem: (localId: string, changes: any) => {
                    setAndSync({ items: get().items.map((i: any) => (i._localId === localId ? { ...i, ...changes } : i)) });
                },
            }),
            { name: 'conflict-store', storage },
            apis,
            { conflictResolutionStrategy: conflictStrategy, syncInterval: 40, minLogLevel: 'none' },
        );
    }

    async function tick(ms = 120) {
        await new Promise((r) => setTimeout(r, ms));
    }

    it('local-wins keeps local change when remote also modified', async () => {
        const { apis, server } = buildApis();
        const store = await buildStore(apis, make(), 'local-wins');

        // seed server with item
        server.push({ id: 1, name: 'srv', updated_at: new Date().toISOString() });

        store.sync.enable(true);
        // allow initial pull
        await tick(80);
        // pause sync so local update is queued but not pushed
        store.sync.enable(false);
        // local modify (creates a pending change)
        const localId = store.getState().items[0]._localId;
        store.getState().updateItem(localId, { name: 'local-change' });
        // remote also modifies server record to different name
        const srv = server.find((s) => s.id === 1)!;
        srv.name = 'remote-change';
        srv.updated_at = new Date(Date.now() + 20).toISOString();

        // ensure server updated_at is later than lastPulled
        await tick(40);

        // resume sync to let pull run with a pending local change
        store.sync.enable(true);
        await tick(200);
        store.sync.enable(false);

        // local-wins => store should keep local-change
        const finalName = store.getState().items.find((i: any) => i._localId === localId)!.name;
        expect(finalName).toBe('local-change');
    });

    it('remote-wins overwrites local change when remote modified', async () => {
        const { apis, server } = buildApis();
        const store = await buildStore(apis, make(), 'remote-wins');

        // seed server with item
        server.push({ id: 1, name: 'srv', updated_at: new Date().toISOString() });

        store.sync.enable(true);
        await tick(80);
        // pause sync so local update is queued but not pushed
        store.sync.enable(false);
        const localId = store.getState().items[0]._localId;
        store.getState().updateItem(localId, { name: 'local-change' });

        // remote changes
        const srv = server.find((s) => s.id === 1)!;
        srv.name = 'remote-change';
        srv.updated_at = new Date(Date.now() + 20).toISOString();
        await tick(40);

        // ensure pending change was recorded
        expect(store.getState().syncState.pendingChanges.length).toBeGreaterThan(0);

        // resume sync
        store.sync.enable(true);
        await tick(200);
        store.sync.enable(false);

        const finalName = store.getState().items.find((i: any) => i._localId === localId)!.name;
        expect(finalName).toBe('remote-change');
    });

    it('try-shallow-merge throws causes conflicts when both changed same field', async () => {
        const { apis, server } = buildApis();
        const store = await buildStore(apis, make(), 'try-shallow-merge');

        server.push({ id: 1, name: 'srv', updated_at: new Date().toISOString() });

        store.sync.enable(true);
        await tick(80);
        // Instead of using the public update helper (which may coalesce), insert a pending change directly
        store.sync.enable(false);
        const localId = store.getState().items[0]._localId;
        // mutate local item to local-change
        store.setState({ items: store.getState().items.map((i: any) => (i._localId === localId ? { ...i, name: 'local-change' } : i)) });
        // add a pendingChanges entry representing the local update
        store.setState({
            syncState: {
                ...(store.getState().syncState || {}),
                pendingChanges: [
                    { action: 'update', stateKey: 'items', localId, id: 1, version: 1, changes: { name: 'local-change' }, before: { name: 'srv' } },
                ],
            },
        });

        // remote changes
        const srv = server.find((s) => s.id === 1)!;
        srv.name = 'remote-change';
        srv.updated_at = new Date(Date.now() + 20).toISOString();
        await tick(40);

        // resume sync
        store.sync.enable(true);

        // wait up to 1s for conflicts to be set under the item's localId
        const start = Date.now();
        while ((!store.getState().syncState.conflicts || !store.getState().syncState.conflicts[localId]) && Date.now() - start < 1000) {
            await new Promise((r) => setTimeout(r, 20));
        }

        // try-shallow-merge should surface conflicts in syncState.conflicts keyed by localId
        store.sync.enable(false);
        const confs = store.getState().syncState.conflicts;
        expect(confs).toBeDefined();
        expect(confs![localId]).toBeDefined();
        expect(confs![localId].fields.length).toBeGreaterThan(0);
    });

    it('try-shallow-merge merges non-conflicting fields from remote', async () => {
        const { apis, server } = buildApis();
        const store = await buildStore(apis, make(), 'try-shallow-merge');

        // seed server with an older timestamp so the later remote update is definitely newer than lastPulled
        server.push({ id: 1, name: 'srv', updated_at: new Date(Date.now() - 10000).toISOString(), extra: 'x' });

        store.sync.enable(true);
        await tick(80);
        // pause and insert local pending change that edits a different field than remote
        store.sync.enable(false);
        const localId = store.getState().items[0]._localId;
        store.setState({ items: store.getState().items.map((i: any) => (i._localId === localId ? { ...i, name: 'local-change' } : i)) });
        store.setState({
            syncState: {
                ...(store.getState().syncState || {}),
                pendingChanges: [
                    {
                        action: 'update',
                        stateKey: 'items',
                        localId,
                        id: 1,
                        version: 1,
                        changes: { name: 'local-change' },
                        before: { name: 'srv', extra: 'x' },
                    },
                ],
            },
        });

        // remote modifies a different field
        const srv = server.find((s) => s.id === 1)!;
        srv.extra = 'remote-extra';
        srv.updated_at = new Date(Date.now() + 20).toISOString();
        await tick(40);

        store.sync.enable(true);
        // wait for sync to complete
        await tick(200);
        store.sync.enable(false);

        // final item should include both local name and remote extra merged
        const final = store.getState().items.find((i: any) => i._localId === localId)!;
        expect(final.name).toBe('local-change');
        expect(final.extra).toBe('remote-extra');
        // no conflicts should be recorded for items
        expect(store.getState().syncState.conflicts?.['items']).toBeUndefined();
    });
});
