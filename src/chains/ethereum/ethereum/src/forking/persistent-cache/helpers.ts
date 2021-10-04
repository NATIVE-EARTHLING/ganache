import { Tag } from "@ganache/ethereum-utils";
import { BUFFER_EMPTY, Data, DATA_EMPTY, Quantity } from "@ganache/utils";
import { AbstractIteratorOptions } from "abstract-leveldown";
import type { LevelUp } from "levelup";
import { Tree } from "./tree";

export type Request = (method: string, params: any[]) => Promise<any>;

export type FindOptions = (
  | {
      gte: Buffer;
      lt?: Buffer;
    }
  | {
      gt: Buffer;
      lt?: Buffer;
    }
  | {
      gt: Buffer;
      lte?: Buffer;
    }
  | {
      gte: Buffer;
      lte?: Buffer;
    }
  | {
      gte?: Buffer;
      lt: Buffer;
    }
  | {
      gt?: Buffer;
      lt: Buffer;
    }
  | {
      gt?: Buffer;
      lte: Buffer;
    }
  | {
      gte?: Buffer;
      lte: Buffer;
    }
) & { reverse?: boolean };

export function getBlockNumberFromParams(method: string, params: any[]) {
  // get the request's block number
  switch (method) {
    case "eth_getBlockByNumber":
      return params[0];
    case "eth_getTransactionCount":
    case "eth_getCode":
    case "eth_getBalance":
      return params[1];
    case "eth_getStorageAt":
      return params[2];
    default:
      throw new Error(`Persistent cache does not support calls to "${method}.`);
  }
}

export async function setDbVersion(db: LevelUp, version: Buffer) {
  // set the version if the DB was just created, or error if we already have
  // a version, but it isn't what we expected
  try {
    const version = await db.get("version");
    if (!version.equals(version)) {
      // in the future this is where database migrations would go
      throw new Error(
        `Persistent cache version "${version.toString()}"" is not understood.`
      );
    }
  } catch (e) {
    if (!e.notFound) throw e;

    // if we didn't have a `version` key we need to set one
    await db.put("version", version);
  }
}

export async function resolveTargetAndClosestAncestor(
  db: LevelUp,
  request: Request,
  targetHeight: Quantity,
  targetHash: Data
) {
  let targetBlock: Tree;
  let closestAncestor: Tree;
  try {
    const key = Tree.encodeKey(targetHeight, targetHash);
    targetBlock = Tree.deserialize(key, await db.get(key));

    if (targetBlock.closestKnownAncestor.equals(BUFFER_EMPTY)) {
      // we are the genesis/earliest block
      closestAncestor = null;
    } else {
      closestAncestor = Tree.deserialize(
        targetBlock.closestKnownAncestor,
        await db.get(targetBlock.closestKnownAncestor)
      );
    }
  } catch (e) {
    // something bad happened (I/O failure?), bail
    if (!e.notFound) throw e;

    // we couldn't find our target block in the database so we need to figure
    // out it's relationships via the blockchain.

    const earliestBlock = await getBlockByNumber(request, Tag.EARLIEST);
    if (!earliestBlock) throw new Error('Could not find "earliest" block.');

    const { hash: earliestHash, number: earliestNumber } = earliestBlock;
    const hash = Data.from(earliestHash, 32);

    const earliest = new Tree(Quantity.from(earliestNumber), hash);

    closestAncestor = await findClosestAncestor(
      db,
      request,
      targetHeight,
      earliest
    );
    targetBlock = new Tree(targetHeight, targetHash, closestAncestor.key);
  }

  return {
    targetBlock,
    closestAncestor
  };
}

export async function* findRelated(
  db: LevelUp,
  request: Request,
  options: FindOptions
) {
  const readStream = db.createReadStream({
    keys: true,
    values: true,
    ...options
  });

  for await (const pair of readStream) {
    const { key, value } = (pair as unknown) as { key: Buffer; value: Buffer };
    const node = Tree.deserialize(key, value);
    const { height: candidateHeight } = node.decodeKey();
    const block = await getBlockByNumber(request, candidateHeight);
    // if the chain has a block at this height, and the hash of the
    // block is the same as the one in the db we've found our closest
    // ancestor!
    if (block !== null && block.hash === Data.from(node.hash).toString()) {
      const shouldContinue = yield node;
      if (!shouldContinue) break;
    }
  }
}

/**
 *
 * @param height Search only before this block height (exclusive)
 * @param upTo Search up to this key (inclusive)
 * @returns the closest known ancestor, or `upTo` if we know of no ancestors
 */
export async function findClosestAncestor(
  db: LevelUp,
  request: Request,
  height: Quantity,
  upTo: Tree
) {
  const generator = findRelated(db, request, {
    gte: upTo.key,
    lt: Tree.encodeKey(height, DATA_EMPTY),
    reverse: true
  });
  const first = await generator.next();
  await generator.return();
  return first.value || upTo;
}

/**
 *
 * @param height Search only after this block height (exclusive)
 * @returns the closest known descendants, or null
 */
export async function* findClosestDescendants(
  db: LevelUp,
  request: Request,
  height: Quantity
) {
  const generator = findRelated(db, request, {
    gte: Tree.encodeKey(Quantity.from(height.toBigInt() + 1n), DATA_EMPTY),
    reverse: false
  });
  for await (const node of generator) {
    yield node;
  }
}

export async function getBlockByNumber(
  request: Request,
  blockNumber: Quantity | Tag
) {
  return await request("eth_getBlockByNumber", [blockNumber.toString(), false]);
}
