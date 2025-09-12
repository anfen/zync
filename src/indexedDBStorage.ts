import type { IDBPDatabase } from 'idb';

export function createIndexedDBStorage(options: { dbName: string; storeName: string }) {
    const dbName = options.dbName;
    const storeName = options.storeName;

    // dbPromise is created lazily by initDB() to avoid pulling `idb` into bundles
    let dbPromise: Promise<IDBPDatabase<any>> | null = null;

    async function initDB(): Promise<IDBPDatabase<any>> {
        if (dbPromise) return dbPromise;
        try {
            const idb = await import(/* webpackChunkName: "idb" */ 'idb');
            dbPromise = idb.openDB(dbName, 1, {
                upgrade(db: IDBPDatabase<any>) {
                    if (!db.objectStoreNames.contains(storeName)) {
                        db.createObjectStore(storeName);
                    }
                },
            });
            return dbPromise;
        } catch (_e) {
            throw new Error('Missing optional dependency "idb". Install it to use IndexedDB storage: npm install idb');
        }
    }

    async function ensureStore(): Promise<void> {
        const db = await initDB();
        if (db.objectStoreNames.contains(storeName)) return;
        const nextVersion = (db.version || 0) + 1;
        try {
            db.close();
        } catch (_e) {
            // ignore
        }
        const idb = await import(/* webpackChunkName: "idb" */ 'idb');
        dbPromise = idb.openDB(dbName, nextVersion, {
            upgrade(upg: IDBPDatabase<any>) {
                if (!upg.objectStoreNames.contains(storeName)) upg.createObjectStore(storeName);
            },
        });
        await dbPromise;
    }

    async function withRetry<T>(fn: (db: IDBPDatabase<any>) => Promise<T>): Promise<T> {
        try {
            const db = await initDB();
            return await fn(db);
        } catch (err: any) {
            const msg = String(err && err.message ? err.message : err);
            if (err && (err.name === 'NotFoundError' || /objectStore/i.test(msg))) {
                await ensureStore();
                const db2 = await initDB();
                return await fn(db2);
            }
            throw err;
        }
    }

    return {
        getItem: async (name: string): Promise<string | null> => {
            return withRetry(async (db) => {
                let v = await db.get(storeName, name);
                v = v ?? null; // Zustand expects null for missing keys
                return v;
            });
        },
        setItem: async (name: string, value: string): Promise<void> => {
            return withRetry(async (db) => {
                await db.put(storeName, value, name);
            });
        },
        removeItem: async (name: string): Promise<void> => {
            return withRetry(async (db) => {
                await db.delete(storeName, name);
            });
        },
    };
}
