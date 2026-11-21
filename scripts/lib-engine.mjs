// Opens an XO engine for one demo wallet on Chipnet. State lives in fake-indexeddb and is snapshotted to ./state (git-ignored).
import { Engine, XO_SUPPORTED_NETWORKS } from '@xo-cash/engine';
import { StorageType } from '@xo-cash/state';
import { p2pkhTemplate } from '@xo-cash/templates';
import { hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { loadSnapshot, saveSnapshot } from './lib-idb-persist.mjs';
import { readEnv } from './lib-env.mjs';

// One XO account per process (the Electrum layer is process-wide), so each wallet has its own snapshot file.
let openedWallet;

export const openWallet = async (name) => {
    const mnemonic = readEnv()[`${name}_MNEMONIC`];
    if (mnemonic === undefined) throw new Error(`No ${name}_MNEMONIC, run scripts/make-wallets.mjs first`);
    if (openedWallet !== undefined) throw new Error(`Only one wallet per process; ${openedWallet} is already open`);
    openedWallet = name;
    await loadSnapshot(name);
    const engine = await Engine.create(mnemonic, {
        network: XO_SUPPORTED_NETWORKS.chipnet,
        storageType: StorageType.INDEXEDDB,
        databasePath: 'lotry-xo',
        databaseFilename: name.toLowerCase(),
    });
    const { templateIdentifier } = await engine.importTemplate(p2pkhTemplate);
    await engine.setDefaultPolicies({
        change: { templateIdentifier },
        receive: { templateIdentifier },
        address: { templateIdentifier },
    });
    return engine;
};

// Saves every wallet's state; call after each step so a crash never loses keys, secrets or invitations.
export const persist = () => saveSnapshot(openedWallet);

export const closeWallet = async (engine) => {
    await persist();
    await engine.stop();
};

export const toCashAddress = (lockingBytecodeHex, tokenSupport = false) => {
    const result = lockingBytecodeToCashAddress({ bytecode: hexToBin(lockingBytecodeHex), prefix: 'bchtest', tokenSupport });
    if (typeof result === 'string') throw new Error(result);
    return result.address;
};
