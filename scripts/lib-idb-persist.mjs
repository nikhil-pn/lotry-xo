// The XO state package only ships a working IndexedDB backend (its SQLite backend is a stub in 0.0.5),
// so Node scripts run on fake-indexeddb and this file snapshots every database to disk between runs.
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';

const request = (idbRequest) => new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error);
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
});

// Reads every database, store, index definition and record into one plain object.
export const dumpDatabases = async (filter = () => true) => {
    const snapshot = [];
    for (const { name, version } of await indexedDB.databases()) {
        if (!filter(name)) continue;
        const database = await request(indexedDB.open(name, version));
        const stores = [];
        for (const storeName of database.objectStoreNames) {
            const transaction = database.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const indexes = [ ...store.indexNames ].map((indexName) => {
                const index = store.index(indexName);
                return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
            });
            const keys = await request(store.getAllKeys());
            const values = await request(store.getAll());
            stores.push({ name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, keys, values });
        }
        database.close();
        snapshot.push({ name, version, stores });
    }
    return snapshot;
};

// Recreates the databases from a snapshot before the engine opens them, so its upgrade handler does not run.
export const restoreDatabases = async (snapshot) => {
    for (const { name, version, stores } of snapshot) {
        const openRequest = indexedDB.open(name, version);
        openRequest.onupgradeneeded = () => {
            const database = openRequest.result;
            for (const definition of stores) {
                const store = database.createObjectStore(definition.name, {
                    keyPath: definition.keyPath ?? undefined,
                    autoIncrement: definition.autoIncrement,
                });
                for (const index of definition.indexes) {
                    store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
                }
            }
        };
        const database = await request(openRequest);
        for (const definition of stores) {
            if (definition.values.length === 0) continue;
            const transaction = database.transaction(definition.name, 'readwrite');
            const store = transaction.objectStore(definition.name);
            definition.values.forEach((value, position) => {
                if (definition.keyPath === null) store.put(value, definition.keys[position]);
                else store.put(value);
            });
            await transactionDone(transaction);
        }
        database.close();
    }
};

// LOTRY_STATE picks the state folder, so a second set of wallets (LOTRY_ENV) keeps its own databases.
export const STATE_DIR = process.env.LOTRY_STATE ?? 'state';

export const snapshotPath = (name) => path.join(STATE_DIR, `${name.toLowerCase()}.idb.bin`);

export const loadSnapshot = async (name) => {
    const file = snapshotPath(name);
    if (!fs.existsSync(file)) return;
    await restoreDatabases(v8.deserialize(fs.readFileSync(file)));
};

export const saveSnapshot = async (name, filter) => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = snapshotPath(name);
    fs.writeFileSync(`${file}.tmp`, v8.serialize(await dumpDatabases(filter)));
    fs.renameSync(`${file}.tmp`, file);
};
