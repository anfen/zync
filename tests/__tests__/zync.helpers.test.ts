import { describe, it, expect, beforeEach } from 'vitest';
import { SyncAction } from '../../src/index';
import {
    createLocalId,
    changeKeysTo,
    changeKeysFrom,
    orderFor,
    omitSyncFields,
    samePendingVersion,
    removeFromPendingChanges,
    tryAddToPendingChanges,
    setPendingChangeToUpdate,
    findApi,
    findChanges,
} from '../../src/helpers';

import type { PendingChange } from '../../src/types';

describe('helpers', () => {
    beforeEach(() => {
        // nothing global for now
    });

    it('createLocalId returns a UUID-like string', () => {
        const id = createLocalId();
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
    });

    describe('changeKeysTo / changeKeysFrom', () => {
        const sample = { id: 1, updated_at: 't1', deleted: false, name: 'bob' };
        it('changeKeysTo maps keys for single object', () => {
            const out = changeKeysTo(sample, 'uuid', 'mtime', 'isDeleted');
            expect(out.uuid).toBe(1);
            expect(out.mtime).toBe('t1');
            expect(out.isDeleted).toBe(false);
            expect(out.name).toBe('bob');
        });

        it('changeKeysTo maps keys for array', () => {
            const out = changeKeysTo([sample], 'uuid', 'mtime', 'isDeleted');
            expect(Array.isArray(out)).toBe(true);
            expect(out[0].uuid).toBe(1);
        });

        it('changeKeysFrom maps keys for single object', () => {
            const remote = { uuid: 2, mtime: 't2', isDeleted: true, name: 'alice' };
            const local = changeKeysFrom(remote, 'uuid', 'mtime', 'isDeleted');
            expect(local.id).toBe(2);
            expect(local.updated_at).toBe('t2');
            expect(local.deleted).toBe(true);
            expect(local.name).toBe('alice');
        });

        it('changeKeysFrom maps keys for array', () => {
            const remote = [{ uuid: 3, mtime: 't3', isDeleted: false, name: 'x' }];
            const local = changeKeysFrom(remote, 'uuid', 'mtime', 'isDeleted');
            expect(Array.isArray(local)).toBe(true);
            expect(local[0].id).toBe(3);
        });

        it('returns falsy input unchanged', () => {
            expect(changeKeysTo(null, 'a', 'b', 'c')).toBeNull();
            expect(changeKeysFrom(undefined as any, 'a', 'b', 'c')).toBeUndefined();
        });
    });

    it('orderFor returns ordering for actions', () => {
        expect(orderFor(SyncAction.Create)).toBeLessThan(orderFor(SyncAction.Update));
        expect(orderFor(SyncAction.Update)).toBeLessThan(orderFor(SyncAction.Remove));
    });

    it('omitSyncFields removes _localId, updated_at, deleted', () => {
        const item = { _localId: 'a', updated_at: 't', deleted: true, foo: 1 };
        const out = omitSyncFields(item);
        expect(out._localId).toBeUndefined();
        expect(out.updated_at).toBeUndefined();
        expect(out.deleted).toBeUndefined();
        expect(out.foo).toBe(1);
    });

    describe('pending changes helpers', () => {
        it('samePendingVersion returns true when matching', () => {
            const state = { syncState: { pendingChanges: [{ localId: 'L1', stateKey: 'things', version: 2 }] } } as any;
            const get = () => state;
            expect(samePendingVersion(get, 'things', 'L1', 2)).toBe(true);
            expect(samePendingVersion(get, 'things', 'L1', 3)).toBe(false);
        });

        it('removeFromPendingChanges filters out entry', () => {
            let state: any = {
                syncState: {
                    pendingChanges: [
                        { localId: 'L1', stateKey: 'things', version: 1 },
                        { localId: 'L2', stateKey: 'things', version: 1 },
                    ],
                },
            };
            const set = (fn: any) => {
                state = { ...state, ...fn(state) };
            };
            removeFromPendingChanges(set, 'L1', 'things');
            expect(state.syncState.pendingChanges.length).toBe(1);
            expect(state.syncState.pendingChanges[0].localId).toBe('L2');
        });

        it('tryAddToPendingChanges adds create/update/remove appropriately', () => {
            const pending: PendingChange[] = [];
            const currentItem = { _localId: 'L1', id: undefined, name: 'old' };
            const updatedItem = { _localId: 'L1', id: undefined, name: 'new' };

            const changes = new Map<string, any>();
            changes.set('L1', { currentItem, updatedItem, changes: { name: 'new' }, id: undefined });

            tryAddToPendingChanges(pending, 'things', changes);
            expect(pending.length).toBe(1);
            expect(pending[0]!.action).toBe(SyncAction.Update);

            // Now simulate addition
            const changes2 = new Map<string, any>();
            const added = { _localId: 'L2', id: undefined, name: 'added' };
            changes2.set('L2', { currentItem: null, updatedItem: added, changes: added, id: undefined });
            tryAddToPendingChanges(pending, 'things', changes2);
            const found = pending.find((p) => p.localId === 'L2');
            expect(found!.action).toBe(SyncAction.Create);

            // Simulate removal
            const changes3 = new Map<string, any>();
            changes3.set('L1', { currentItem: updatedItem, updatedItem: null, changes: null, id: undefined });
            tryAddToPendingChanges(pending, 'things', changes3);
            const rem = pending.find((p) => p.localId === 'L1');
            expect(rem!.action).toBe(SyncAction.Remove);
        });

        it('tryAddToPendingChanges coalesces multiple changes and increments version', () => {
            const pending: PendingChange[] = [
                { action: SyncAction.Update, stateKey: 'things', localId: 'L1', id: undefined, version: 1, changes: { a: 1 } } as any,
            ];
            const changes = new Map<string, any>();
            changes.set('L1', {
                currentItem: { _localId: 'L1', id: undefined },
                updatedItem: { _localId: 'L1', id: undefined, b: 2 },
                changes: { b: 2 },
                id: undefined,
            });
            tryAddToPendingChanges(pending, 'things', changes);
            expect(pending[0]!.version).toBe(2);
            expect((pending[0]!.changes as any).b).toBe(2);
        });

        it('setPendingChangeToUpdate flips action to update and sets id', () => {
            const state = { syncState: { pendingChanges: [{ action: SyncAction.Create, stateKey: 'things', localId: 'L1', version: 1 }] } } as any;
            const get = () => state;
            setPendingChangeToUpdate(get, 'things', 'L1', 42);
            expect(state.syncState.pendingChanges[0].action).toBe(SyncAction.Update);
            expect(state.syncState.pendingChanges[0].id).toBe(42);
        });
    });

    it('findApi throws when missing functions', () => {
        const ok = {
            add: async (_item: any) => ({}),
            update: async (_id: any, _changes: any) => true,
            remove: async (_id: any) => {},
            list: async (_d: Date) => [],
            firstLoad: async (_d: any) => [],
        };
        const api = findApi('a', { a: ok });
        expect(api).toBe(ok as any);
        expect(() => findApi('b', { a: ok as any })).toThrow();
    });

    describe('findChanges', () => {
        it('detects additions, updates and deletes', () => {
            const current = [
                { _localId: 'A', id: 1, name: 'one', updated_at: 't1' },
                { _localId: 'B', id: 2, name: 'two', updated_at: 't1' },
            ];
            const updated = [
                { _localId: 'A', id: 1, name: 'one-mod', updated_at: 't2' },
                { _localId: 'C', id: 3, name: 'three', updated_at: 't3' },
            ];

            const m = findChanges(current, updated);
            // A changed
            expect(m.has('A')).toBe(true);
            const a = m.get('A')!;
            expect(a.currentItem.name).toBe('one');
            expect(a.updatedItem.name).toBe('one-mod');
            expect(a.changes).toHaveProperty('name');

            // B deleted
            expect(m.has('B')).toBe(true);
            const b = m.get('B')!;
            expect(b.updatedItem).toBeNull();

            // C added
            expect(m.has('C')).toBe(true);
            const c = m.get('C')!;
            expect(c.currentItem).toBeNull();
            expect(c.updatedItem.name).toBe('three');
        });

        it('ignores items without _localId', () => {
            const current = [{ id: 1, name: 'no-local' } as any];
            const updated = [{ id: 1, name: 'no-local' } as any];
            const m = findChanges(current, updated);
            expect(m.size).toBe(0);
        });
    });
});
