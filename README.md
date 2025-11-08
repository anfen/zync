# Zync

[![npm version](https://img.shields.io/npm/v/@anfenn/zync.svg)](https://www.npmjs.com/package/@anfenn/zync)

Simple, unopinionated, bullet-proof, offline-first sync middleware for Zustand.

## Use Case

Zync is when you want to persist and sync small amounts of state in a website or PWA. It's ideal if you know you'll never need the power of
sqlite or the complexity of DB schemas and relationships, and it keeps your components free from wiring-up code and allows you to use pure JS to select/sort/mutate your state.

The tradeoff however is although Zustand can use IndexedDB, it will store all state in one key, and so load it all into the JS VM.

When you need sqlite, or you know the client will need large amounts of data, [WatermelondDB](https://github.com/nozbe/WatermelonDB) is what you want. This will however require a backend that provides the PUSH/PULL endpoints for synchronising or perhaps modifying the frontend to redirect those requests to and from specific endpoints.

## Benefits

- Easy to sync non-nested array state with a backend (i.e. mirror remote database tables locally)
- **"It just works"** philosophy
- Optimistic UI updates
- Conflict resolution:
    - `'local-wins'` | `'remote-wins'` | `'try-shallow-merge'`
    - `'try-shallow-merge'` allows the user to choose between local and remote changes if conflicts occur
- Missing remote record during update strategy, to prevent accidental server deletion from losing local data:
    - `'ignore'` | `'delete-local-record'` | `'insert-remote-record'`
- Batteries optionally included:
    - IndexedDB helper (based on [idb](https://www.npmjs.com/package/idb)): `createIndexedDB()`
    - UUID helper: `createLocalId()`
    - Object|Array key rename helpers to map endpoint fields to Zync: `changeKeysFrom()` & `changeKeysTo()`
- Uses the official persist middleware as the local storage (localStorage, IndexedDB, etc.)
- Zync's `persistWithSync()` is a drop-in replacement for Zustand's `persist()`
- Allows for idiomatic use of Zustand
- Leaves the api requests up to you (RESTful, GraphQL, etc.), just provide `add()`, `update()`, `remove()` and `list()`
- Client or server assigned primary key, of any datatype
- Fully tested on `localstorage` and `IndexedDB` (>80% code coverage, including stress tests)
- Client schema migrations are a breeze using Zustand's [migrate](https://zustand.docs.pmnd.rs/middlewares/persist#persisting-a-state-through-versioning-and-migrations) hook
- All Zync's internal state is accessible via the reactive `state.syncState` object
- Zero boilerplate code

## Requirements

- Client records will have a `_localId` field which is stable and never sent to the server. It is ideal for use as a key in JSX. The provided helper function `createLocalId()` returns a UUID, but you could use any unique value
- Server records must have:

    - `id`: Any datatype, can be client OR server assigned
    - `updated_at`: Server assigned **_millisecond_** timestamp (e.g. via db trigger or api layer). The client will never send this as the client clock is unlikely to be in sync with the server, so is never used for change detection. If it has a higher precision than millisecond, like PostgreSQL's microsecond timestampz, updates could be ignored.
    - `deleted`: Boolean, used for soft deletes, to allow other clients to download deleted records to keep their local records in sync

    **_TIP: If your endpoint doesn't have the same names as the 3 fields above, you can easily rename them in your `api.ts` file using the included `changeKeysFrom()` & `changeKeysTo()`_**

## Quickstart

```bash
npm install zustand @anfenn/zync
```

_The example below uses server assigned id's, but you can just set the id when creating an object for client assigned id's._

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
                const updated_at = new Date().toISOString(); // Optimistic UI update only, never sent to server
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
            // OR storage: createJSONStorage(() => createIndexedDB('my-app', 'my-store')),
        },
        {
            // State-to-API map to enable syncing. Must implement the full CRUD API:
            //
            // add: (item: any) => Promise<any | undefined>
            // update: (id: any, changes: any, item: any) => Promise<boolean>
            // remove: (id: any) => Promise<void>
            // list: (lastUpdatedAt: Date) => Promise<any[]>
            // firstLoad: (lastId: any) => Promise<any[]> (Optional)

            facts: factApi,
        },
        {
            // Default: 2000 (ms)
            syncInterval: 2000,

            // Default: undefined (ms)
            // Override syncInterval above for just pull requests, per api (Push requests are still controlled by syncInterval)
            // Has no effect if less than syncInterval
            apiConfig: { facts: { pullInterval: 10000 } },

            // Options: 'ignore' | 'delete-local-record' | 'insert-remote-record'
            // Default: 'ignore'
            // Triggered by api.update() returning false confirming the absence of the remote record
            missingRemoteRecordDuringUpdateStrategy: 'ignore',

            // Options: 'local-wins' | 'remote-wins' | 'try-shallow-merge'
            // Default: 'try-shallow-merge' (Conflicts are listed in syncState.conflicts)
            conflictResolutionStrategy: 'try-shallow-merge',
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

**_NOTE_**: Zync uses an internal timer (setInterval) to sync, so it's advised to just have one store. You could have multiple, with different store names (see Zustand persist options above), but if both stores use Zync, although it would work fine, it wouldn't offer much advantage. If one store becomes large with many state keys and functions, then you could separate them into multiple files and import them with object spreading
`e.g. {...storeState1, ...storeState2}`

### In your component:

```ts
import { useEffect } from 'react';
import { createLocalId } from '@anfenn/zync';
import { useFacts, useStore } from './store';

function App() {
    // Your state
    const { facts, addFact } = useFacts();

    // Zync's internal sync state
    const syncState = useStore((state) => state.syncState);
    // syncState.status // 'disabled' | 'hydrating' | 'syncing' | 'idle'
    // syncState.error
    // syncState.conflicts
    // syncState.firstLoadDone
    // syncState.pendingChanges
    // syncState.lastUpdatedAt
    // syncState.lastPulled

    useEffect(() => {
        // Zync's control api
        useStore.sync.enable(true);                     // Defaults to false, enable to start syncing
        //useStore.sync.startFirstLoad();               // Batch loads from server
        //useStore.sync.resolveConflict(localId, true); // Keep local or remote changes for a specific record
    }, []);

    return (
        <>
            <div>Sync Status: {syncState.status}</div>
            <button
                onClick={() =>
                    addFact({ _localId: createLocalId(), title: 'Fact ' + Date.now() })
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
    id?: number; // Client OR server assigned
    updated_at?: string; // Server assigned
};

export const factApi: ApiFunctions = { add, update, remove, list, firstLoad };

async function add(item: any): Promise<any | undefined> {
    const { data, error } = await supabase.from('fact').insert(item).select();

    if (error) {
        // Throw errors to cause Zync to retry
        throw new Error(error.message);
    }

    if (data?.length > 0) {
        // Return server id if not using client assigned id's, and any other fields you want merged in
        return { id: data[0].id };
    }
}

async function update(id: number, changes: any, item: any): Promise<boolean> {
    const { status, statusText, data } = await supabase.from('fact').update(changes).eq('id', id).select();

    if (status !== 200) {
        throw new Error(statusText);
    }

    // Return if record exists to trigger the Zync missingRemoteRecordDuringUpdateStrategy of either:
    // 'ignore' | 'delete-local-record' | 'insert-remote-record'
    const exists = !!data?.[0];
    return exists;
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

Using **_async_** IndexedDB over **_sync_** localStorage gives the advantage of a responsive UI when reading/writing a very large store, as IndexedDB is running in it's own thread.

If you want to use the bundled `createIndexedDB()` helper, install `idb` in your project. It's intentionally optional so projects that don't use IndexedDB won't pull the dependency into their bundles.

[idb](https://www.npmjs.com/package/idb) is an extremely popular and lightweight wrapper to simplify IndexedDB's verbose events based api into a simple Promise based one. It also handles the inconsistencies found when running in different browsers.

```bash
npm install idb
```

## Community

PRs are welcome! [pnpm](https://pnpm.io) is used as a package manager. Run `pnpm install` to install local dependencies. Thank you for contributing!
