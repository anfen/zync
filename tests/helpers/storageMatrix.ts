import { createIndexedDBStorage } from '../../src/indexedDBStorage';
import { createJSONStorage } from 'zustand/middleware';

export type TestStorageFactory = {
    label: string;
    make: () => { getItem: any; setItem: any; removeItem: any };
};

// Each factory returns a fresh, isolated storage implementation.
export const storageMatrix: TestStorageFactory[] = [
    {
        label: 'localStorage-sync',
        make: () => {
            return createJSONStorage(() => {
                const mem: Record<string, string> = {};
                return {
                    getItem: async (k: string) => (k in mem ? mem[k]! : null),
                    setItem: async (k: string, v: string) => {
                        mem[k] = v;
                    },
                    removeItem: async (k: string) => {
                        delete mem[k];
                    },
                };
            })!;
        },
    },
    {
        label: 'indexedDB-async',
        make: () => {
            // Use createJSONStorage to ensure the persisted state is JSON-stringified
            // before being handed to the underlying IndexedDB storage. This prevents
            // storing non-serializable values (functions) which fake-indexeddb
            // enforces via the structured clone algorithm.
            return createJSONStorage(() =>
                createIndexedDBStorage(
                    // Use a unique DB name per test-run to avoid cross-test
                    // IndexedDB version/upgrade contention when multiple tests
                    // open the same DB with different object store names.
                    `test-db-${Math.random().toString(36).slice(2)}`,
                    `store-${Math.random().toString(36).slice(2)}`,
                ),
            )!;
        },
    },
];
