import type { UseBoundStore, StoreApi } from 'zustand';
import type { PersistOptions } from 'zustand/middleware';
import type { LogLevel } from './logger';
import { SyncAction } from './index';

export type SyncedRecord = {
    id?: any;
    _localId: string;
    updated_at: string;
    deleted?: boolean;
    [k: string]: any;
};

export interface ApiFunctions {
    add: (item: any) => Promise<any | undefined>;
    update: (id: any, changes: any, item: any) => Promise<boolean>;
    remove: (id: any) => Promise<void>;
    list: (lastUpdatedAt: Date) => Promise<any[]>;
    firstLoad?: (lastId: any) => Promise<any[]>;
}

export type MissingRemoteRecordStrategy = 'ignore' | 'delete-local-record' | 'insert-remote-record';
export type ConflictResolutionStrategy = 'local-wins' | 'remote-wins' | 'try-shallow-merge';

export type SetAndSyncCallback = (state: any) => void;
export type AfterRemoteAddCallback = (set: any, get: any, setAndSync: SetAndSyncCallback, stateKey: string, item: SyncedRecord) => void;
export type MissingRemoteRecordDuringUpdateCallback = (strategy: MissingRemoteRecordStrategy, item: SyncedRecord) => void;

type ApiName = string;
type LocalId = string;
type ISODateString = string;

export interface SyncOptions {
    syncInterval?: number;
    apiConfig?: Record<ApiName, ApiConfig>;
    logger?: any;
    minLogLevel?: LogLevel;
    onAfterRemoteAdd?: AfterRemoteAddCallback;
    missingRemoteRecordDuringUpdateStrategy?: MissingRemoteRecordStrategy;
    onMissingRemoteRecordDuringUpdate?: MissingRemoteRecordDuringUpdateCallback;
    conflictResolutionStrategy?: ConflictResolutionStrategy;
}

export type ApiConfig = {
    pullInterval?: number;
};

export type SyncState = {
    syncState: {
        status: 'disabled' | 'hydrating' | 'syncing' | 'idle';
        firstLoadDone: boolean;
        pendingChanges: PendingChange[];
        lastUpdatedAt: Record<ApiName, ISODateString>;
        lastPulled: Record<ApiName, ISODateString>;
        error?: Error;
        conflicts?: Record<LocalId, Conflict>;
    };
};

export type SyncedStateCreator<TStore> = (set: any, get: any, setAndSyncOnce: SetAndSyncCallback) => TStore;

export interface PendingChange {
    action: SyncAction;
    stateKey: string;
    localId: string;
    id?: any;
    version: number;
    changes?: any;
    before?: any; // Used during conflict resolution
    after?: any; // Used to provide ApiFunctions.update() with full changed object
}

export type UseStoreWithSync<T> = UseBoundStore<
    StoreApi<T & SyncState> & {
        sync: {
            enable: (e: boolean) => void;
            startFirstLoad: () => Promise<void>;
            resolveConflict: (localId: string, keepLocal: boolean) => void;
        };
        persist: {
            setOptions: (options: Partial<PersistOptions<T, any, any>>) => void;
            clearStorage: () => void;
            rehydrate: () => Promise<void> | void;
            hasHydrated: () => boolean;
            onHydrate: (fn: (state: T) => void) => () => void;
            onFinishHydration: (fn: (state: T) => void) => () => void;
            getOptions: () => Partial<PersistOptions<T, any, any>>;
        };
    }
>;

export interface Conflict {
    stateKey: string;
    fields: FieldConflict[];
}

export interface FieldConflict {
    key: string;
    localValue: any;
    remoteValue: any;
}
