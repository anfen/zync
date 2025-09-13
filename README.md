# Zync

[![npm version](https://img.shields.io/npm/v/@anfenn/zync.svg)](https://www.npmjs.com/package/@anfenn/zync)

Unopinionated, bullet-proof, offline-first sync middleware for Zustand.

## Benefits

- Uses the official persist middleware as the local storage (localStorage, IndexedDB, etc.)
- Zync's persistWithSync() is a drop-in replacement for Zustand's persist()
- Allows for idiomatic use of Zustand
- Leaves the api requests up to you (RESTful, GraphQL, etc.), just provide add(), update(), remove() and list()

## Requirements

- Client records will have a `_localId` field which is stable and never sent to the server. It is ideal for use as a key in JSX. The provided helper function `nextLocalId()` returns a UUID, but you could use any unique value
- Server records must have:
    - `id`: Server assigned unique identifier (any datatype)
    - `updated_at`: Server assigned **_millisecond_** timestamp (db trigger or api layer). The client will never send this as the client clock is unlikely to be in sync with the server, so is never used for change detection. If it has a higher precision than millisecond, like PostgreSQL's microsecond timestampz, updates could be ignored.
    - `deleted`: Boolean, used for soft deletes, to allow other clients to download deleted records to keep their local records in sync

## Quickstart

```bash
npm install @anfenn/zync
```

### Zustand store creation:

```ts
import { SyncAction, UseStoreWithSync, persistWithSync } from '@anfenn/zync';
import { create } from 'zustand';
import { createJSONStorage } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';

type Store = {
    facts: Fact[];
    addFact: (item: Fact) => void;
    updateFact: (localId: string, changes: Partial<Fact>) => void;
    removeFact: (localId: string) => void;
};

export const useStore = create<any>()(
    persistWithSync<Store>(
        (set, get, queueToSync) => ({
            // Standard Zustand state and mutation functions with new queueToSync()

            facts: [],
            addFact: (item: Fact) => {
                const updated_at = new Date().toISOString();
                const newItem = { ...item, created_at: updated_at, updated_at };

                set((state: Store) => ({
                    facts: [...state.facts, newItem],
                }));

                queueToSync(SyncAction.CreateOrUpdate, item._localId, 'facts');
            },
            updateFact: (localId: string, changes: Partial<Fact>) => {
                set((state: Store) => ({
                    facts: state.facts.map((item) => (item._localId === localId ? { ...item, ...changes } : item)),
                }));

                queueToSync(SyncAction.CreateOrUpdate, localId, 'facts');
            },
            removeFact: (localId: string) => {
                queueToSync(SyncAction.Remove, 'facts', localId);

                set((state: Store) => ({
                    facts: state.facts.filter((item) => item._localId !== localId),
                }));
            },
        }),
        {
            // Standard Zustand persist options

            name: 'store',
            storage: createJSONStorage(() => localStorage),
            // storage: createJSONStorage(() => createIndexedDBStorage({ dbName: 'my-app', storeName: 'store' })),
        },
        {
            // State-to-API map to enable syncing. Must implement the full CRUD API:
            //
            // add: (item: any) => Promise<any | undefined>
            // update: (id: any, changes: any) => Promise<boolean>
            // remove: (id: any) => Promise<void>
            // list: (lastUpdatedAt: Date) => Promise<any[]>
            // firstLoad: (lastId: any) => Promise<any[]> (Optional)

            facts: factApi,
        },
    ),
) as UseStoreWithSync<Store>;

export const useFacts = () =>
    useStore(
        useShallow(({ facts, addFact, updateFact, removeFact }) => ({
            facts,
            addFact,
            updateFact,
            removeFact,
        })),
    );
```

### In your component:

```ts
// Your state
const { facts, addFact } = useFacts();

// Zync's internal sync state
const syncState = useStore((state) => state.syncState);
// syncState.status // 'hydrating' | 'syncing' | 'idle'
// syncState.error
// syncState.enabled
// syncState.firstLoadDone
// syncState.pendingChanges
// syncState.lastPulled

// Zync's control api
useStore.sync.enable(true | false);
useStore.sync.startFirstLoad();
```

## Optional IndexedDB storage

When using IndexedDB Zustand saves the whole store under one key, which means indexes cannot be used to accelerate querying. However, if this becomes a performance issue due to the size of the store, then libraries like dexie.js instead of Zustand would be a better solution and provide the syntax for high performance queries.

If you want to use the bundled `createIndexedDBStorage()` helper, install `idb` in your project. It's intentionally optional so projects that don't use IndexedDB won't pull the dependency into their bundles.

Install for runtime usage:

```bash
npm install idb
```

Or add it as an optional dependency of your package:

```bash
npm install --save-optional idb
```

The library will throw a helpful runtime error if `idb` isn't installed when `createIndexedDBStorage()` is invoked.
