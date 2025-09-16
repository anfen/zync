# Zync

[![npm version](https://img.shields.io/npm/v/@anfenn/zync.svg)](https://www.npmjs.com/package/@anfenn/zync)

Simple, bullet-proof, offline-first sync middleware for Zustand.

**_STATUS_**: Actively developed in alpha stage while requirements are being understood. Api may change, requests are welcome.

## Benefits

- Easy to sync non-nested array state with a backend (i.e. mirror remote database tables locally)
- **"It just works"** philosophy
- Batteries optionally included:
    - IndexedDB helper (based on [idb](https://www.npmjs.com/package/idb))
- Uses the official persist middleware as the local storage (localStorage, IndexedDB, etc.)
- Zync's persistWithSync() is a drop-in replacement for Zustand's persist()
- Allows for idiomatic use of Zustand
- Leaves the api requests up to you (RESTful, GraphQL, etc.), just provide add(), update(), remove() and list()
- **_Coming soon_**: Customisable conflict resolution. Currently local-wins.

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

### Zustand store creation (store.ts):

```ts
import { type UseStoreWithSync, persistWithSync } from '@anfenn/zync';
import { create } from 'zustand';
import { createJSONStorage } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import { factApi, type Fact } from './api';

type Store = {
    facts: Fact[];
    addFact: (item: Fact) => void;
    updateFact: (localId: string, changes: Partial<Fact>) => void;
    removeFact: (localId: string) => void;
};

export const useStore = create<any>()(
    persistWithSync<Store>(
        (set, get, setAndSync) => ({
            // Standard Zustand state and mutation functions with new setAndSync()

            facts: [],
            addFact: (item: Fact) => {
                const updated_at = new Date().toISOString();
                const newItem = { ...item, created_at: updated_at, updated_at };

                setAndSync((state: Store) => ({
                    facts: [...state.facts, newItem],
                }));
            },
            updateFact: (localId: string, changes: Partial<Fact>) => {
                setAndSync((state: Store) => ({
                    facts: state.facts.map((item) => (item._localId === localId ? { ...item, ...changes } : item)),
                }));
            },
            removeFact: (localId: string) => {
                setAndSync((state: Store) => ({
                    facts: state.facts.filter((item) => item._localId !== localId),
                }));
            },
        }),
        {
            // Standard Zustand persist options

            name: 'store',
            storage: createJSONStorage(() => localStorage),
            // OR storage: createJSONStorage(() => createIndexedDBStorage({ dbName: 'my-app', storeName: 'store' })),
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

**_NOTE_**: Zync uses an internal timer (setInterval) to sync, so it's advised to just have one store. You could have multiple, with different store names (see Zustand persist options above), but if both stores use Zync, although it would work fine, it wouldn't offer much advantage. If one store becomes large with many state keys and functions, then you could separate them into multiple files and import than with object spreading
`e.g. {...storeState1, ...storeState2}`

### In your component:

```ts
import { useEffect } from 'react';
import { nextLocalId } from '@anfenn/zync';
import { useFacts, useStore } from './store';

function App() {
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

    useEffect(() => {
        // Zync's control api
        useStore.sync.enable(true);       // Defaults to false, enable to start syncing
        //useStore.sync.startFirstLoad(); // Batch loads from server
    }, []);

    return (
        <>
            <div>Sync Status: {syncState.status}</div>
            <button
                onClick={() =>
                    addFact({
                        _localId: nextLocalId(),
                        title: 'New fact ' + Date.now(),
                    })
                }
            >
                Add Fact
            </button>
            {
                facts.map((fact) => (
                    <div key={fact._localId}>{fact.title}</div>
                ))
            }
        </>
    );
}
```

### In your api.ts:

_(Supabase example, but could be fetch, GraphQL, etc.)_

```ts
import type { ApiFunctions } from '@anfenn/zync';
import { supabase } from './supabase'; // Please include your own :)

export type Fact = {
    _localId: string;
    fact: string;
    // Server assigned fields
    id?: number;
    updated_at?: string;
};

export const factApi: ApiFunctions = { add, update, remove, list, firstLoad };

async function add(item: any): Promise<any | undefined> {
    const { data, error } = await supabase.from('fact').insert(item).select();

    if (error) {
        // Throw errors to cause Zync to retry
        throw new Error(error.message);
    }

    if (data && data.length > 0) {
        // Must return server id, and any other fields you want merged in
        return { id: data[0].id };
    }
}

async function update(id: number, changes: any): Promise<boolean> {
    const { status, statusText, data } = await supabase.from('fact').update(changes).eq('id', id).select();

    if (status !== 200) {
        throw new Error(statusText);
    }

    // Must return success boolean to tell Zync to dequeue update
    const changed = !!data?.[0];
    return changed;
}

// Soft delete
async function remove(id: number) {
    const payload = {
        deleted: true,
    };

    const { status, statusText } = await supabase.from('fact').update(payload).eq('id', id);

    if (status !== 204) {
        throw new Error(statusText);
    }
}

async function list(lastUpdatedAt: Date) {
    const { data, error } = await supabase.from('fact').select().gt('updated_at', lastUpdatedAt.toISOString());

    if (error) {
        throw new Error(error.message);
    }

    return data;
}

// Optional, for if you want to download all data when your app is first used
// Called until no more records are returned
async function firstLoad(lastId: any) {
    // Initially undefined, so you can choose the datatype (e.g. numeric or string id)
    // Zync will remember the last id returned, having sorted in ascending order, and passes it in as lastId next time
    if (!lastId) lastId = 0;

    const { data, error } = await supabase.from('fact').select().limit(1000).order('id', { ascending: true }).gt('id', lastId);

    if (error) {
        throw new Error(error.message);
    }

    return data;
}
```

## Optional IndexedDB storage

Using async IndexedDB over sync localStorage gives the advantage of a responsive UI when reading/writing a very large store, as IndexedDB is running in it's own thread.

If you want to use the bundled `createIndexedDBStorage()` helper, install `idb` in your project. It's intentionally optional so projects that don't use IndexedDB won't pull the dependency into their bundles.

[idb](https://www.npmjs.com/package/idb) is an extremely popular and lightweight wrapper to simplify IndexedDB's verbose events based api into a simple Promise based one. It also handles the inconsistencies found when running in different browsers.

```bash
npm install idb
```

When using IndexedDB Zustand saves the whole store under one key, which means indexes cannot be used to accelerate querying. However, if this becomes a performance issue due to the size of the store, then libraries like dexie.js instead of Zustand would be a better solution and provide the syntax for high performance queries.

From testing I've found Zustand and Zync are lightening fast even with 100,000 average sized state objects.

## Community

PRs are welcome! [pnpm](https://pnpm.io) is used as a package manager. Run `pnpm install` to install local dependencies. Thank you for contributing!
