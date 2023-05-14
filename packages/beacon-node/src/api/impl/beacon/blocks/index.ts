import {routes, ServerApi} from "@lodestar/api";
import {computeTimeAtSlot} from "@lodestar/state-transition";
import {SLOTS_PER_HISTORICAL_ROOT} from "@lodestar/params";
import {sleep} from "@lodestar/utils";
import {allForks, deneb} from "@lodestar/types";
import {fromHexString, toHexString} from "@chainsafe/ssz";
import {BlockSource, getBlockInput, ImportBlockOpts, BlockInput} from "../../../../chain/blocks/types.js";
import {promiseAllMaybeAsync} from "../../../../util/promises.js";
import {isOptimisticBlock} from "../../../../util/forkChoice.js";
import {BlockError, BlockErrorCode} from "../../../../chain/errors/index.js";
import {OpSource} from "../../../../metrics/validatorMonitor.js";
import {NetworkEvent} from "../../../../network/index.js";
import {ApiModules} from "../../types.js";
import {ckzg} from "../../../../util/kzg.js";
import {resolveBlockId, toBeaconHeaderResponse} from "./utils.js";

/**
 * Validator clock may be advanced from beacon's clock. If the validator requests a resource in a
 * future slot, wait some time instead of rejecting the request because it's in the future
 */
const MAX_API_CLOCK_DISPARITY_MS = 1000;

/**
 * PeerID of identity keypair to signal self for score reporting
 */
const IDENTITY_PEER_ID = ""; // TODO: Compute identity keypair

export function getBeaconBlockApi({
  chain,
  config,
  metrics,
  network,
  db,
}: Pick<ApiModules, "chain" | "config" | "metrics" | "network" | "db">): ServerApi<routes.beacon.block.Api> {
  return {
    async getBlockHeaders(filters) {
      // TODO - SLOW CODE: This code seems like it could be improved

      // If one block in the response contains an optimistic block, mark the entire response as optimistic
      let executionOptimistic = false;

      const result: routes.beacon.BlockHeaderResponse[] = [];
      if (filters.parentRoot) {
        const parentRoot = filters.parentRoot;
        const finalizedBlock = await db.blockArchive.getByParentRoot(fromHexString(parentRoot));
        if (finalizedBlock) {
          result.push(toBeaconHeaderResponse(config, finalizedBlock, true));
        }
        const nonFinalizedBlocks = chain.forkChoice.getBlockSummariesByParentRoot(parentRoot);
        await Promise.all(
          nonFinalizedBlocks.map(async (summary) => {
            const block = await db.block.get(fromHexString(summary.blockRoot));
            if (block) {
              const cannonical = chain.forkChoice.getCanonicalBlockAtSlot(block.message.slot);
              if (cannonical) {
                result.push(toBeaconHeaderResponse(config, block, cannonical.blockRoot === summary.blockRoot));
                if (isOptimisticBlock(cannonical)) {
                  executionOptimistic = true;
                }
              }
            }
          })
        );
        return {
          executionOptimistic,
          data: result.filter(
            (item) =>
              // skip if no slot filter
              !(filters.slot !== undefined && filters.slot !== 0) || item.header.message.slot === filters.slot
          ),
        };
      }

      const headSlot = chain.forkChoice.getHead().slot;
      if (!filters.parentRoot && filters.slot === undefined) {
        filters.slot = headSlot;
      }

      if (filters.slot !== undefined) {
        // future slot
        if (filters.slot > headSlot) {
          return {executionOptimistic: false, data: []};
        }

        const canonicalBlock = await chain.getCanonicalBlockAtSlot(filters.slot);
        // skip slot
        if (!canonicalBlock) {
          return {executionOptimistic: false, data: []};
        }
        const canonicalRoot = config
          .getForkTypes(canonicalBlock.message.slot)
          .BeaconBlock.hashTreeRoot(canonicalBlock.message);
        result.push(toBeaconHeaderResponse(config, canonicalBlock, true));

        // fork blocks
        // TODO: What is this logic?
        await Promise.all(
          chain.forkChoice.getBlockSummariesAtSlot(filters.slot).map(async (summary) => {
            if (isOptimisticBlock(summary)) {
              executionOptimistic = true;
            }

            if (summary.blockRoot !== toHexString(canonicalRoot)) {
              const block = await db.block.get(fromHexString(summary.blockRoot));
              if (block) {
                result.push(toBeaconHeaderResponse(config, block));
              }
            }
          })
        );
      }

      return {
        executionOptimistic,
        data: result,
      };
    },

    async getBlockHeader(blockId) {
      const {block, executionOptimistic} = await resolveBlockId(chain.forkChoice, db, blockId);
      return {
        executionOptimistic,
        data: toBeaconHeaderResponse(config, block, true),
      };
    },

    async getBlock(blockId) {
      const {block} = await resolveBlockId(chain.forkChoice, db, blockId);
      return {
        data: block,
      };
    },

    async getBlockV2(blockId) {
      const {block, executionOptimistic} = await resolveBlockId(chain.forkChoice, db, blockId);
      return {
        executionOptimistic,
        data: block,
        version: config.getForkName(block.message.slot),
      };
    },

    async getBlockAttestations(blockId) {
      const {block, executionOptimistic} = await resolveBlockId(chain.forkChoice, db, blockId);
      return {
        executionOptimistic,
        data: Array.from(block.message.body.attestations),
      };
    },

    async getBlockRoot(blockId) {
      // Fast path: From head state already available in memory get historical blockRoot
      const slot = typeof blockId === "string" ? parseInt(blockId) : blockId;
      if (!Number.isNaN(slot)) {
        const head = chain.forkChoice.getHead();

        if (slot === head.slot) {
          return {
            executionOptimistic: isOptimisticBlock(head),
            data: {root: fromHexString(head.blockRoot)},
          };
        }

        if (slot < head.slot && head.slot <= slot + SLOTS_PER_HISTORICAL_ROOT) {
          const state = chain.getHeadState();
          return {
            executionOptimistic: isOptimisticBlock(head),
            data: {root: state.blockRoots.get(slot % SLOTS_PER_HISTORICAL_ROOT)},
          };
        }
      } else if (blockId === "head") {
        const head = chain.forkChoice.getHead();
        return {
          executionOptimistic: isOptimisticBlock(head),
          data: {root: fromHexString(head.blockRoot)},
        };
      }

      // Slow path
      const {block, executionOptimistic} = await resolveBlockId(chain.forkChoice, db, blockId);
      return {
        executionOptimistic,
        data: {root: config.getForkTypes(block.message.slot).BeaconBlock.hashTreeRoot(block.message)},
      };
    },

    async publishBlindedBlock(signedBlindedBlockOrContents) {
      const executionBuilder = chain.executionBuilder;
      if (!executionBuilder) throw Error("exeutionBuilder required to publish SignedBlindedBeaconBlock");
      // Mechanism for blobs & blocks on builder is not yet finalized
      if ((signedBlindedBlockOrContents as allForks.SignedBlindedBlockContents).signedBlindedBlock !== undefined) {
        throw Error("exeutionBuilder not yet implemented for deneb+ forks");
      } else {
        const signedBlockOrContents = await executionBuilder.submitBlindedBlock(
          signedBlindedBlockOrContents as allForks.SignedBlindedBeaconBlock
        );
        // the full block is published by relay and it's possible that the block is already known to us by gossip
        // see https://github.com/ChainSafe/lodestar/issues/5404
        return this.publishBlock(signedBlockOrContents, {ignoreIfKnown: true});
      }
    },

    async publishBlock(signedBlockOrContents, opts?: ImportBlockOpts) {
      const seenTimestampSec = Date.now() / 1000;
      let blockForImport: BlockInput, signedBlock: allForks.SignedBeaconBlock, signedBlobs: deneb.SignedBlobSidecars;

      if ((signedBlockOrContents as allForks.SignedBlockContents).signedBlock !== undefined) {
        // Build a blockInput for post deneb, signedBlobs will be be used in followup PRs
        ({signedBlock, signedBlobSidecars: signedBlobs} = signedBlockOrContents as allForks.SignedBlockContents);
        const beaconBlockSlot = signedBlock.message.slot;
        const beaconBlockRoot = config.getForkTypes(beaconBlockSlot).BeaconBlock.hashTreeRoot(signedBlock.message);
        const blobs = signedBlobs.map((sblob) => sblob.message.blob);

        blockForImport = getBlockInput.postDeneb(
          config,
          signedBlock,
          BlockSource.api,
          // The blobsSidecar will be replaced in the followup PRs with just blobs
          {
            beaconBlockRoot,
            beaconBlockSlot,
            blobs,
            kzgAggregatedProof: ckzg.computeAggregateKzgProof(blobs),
          }
        );
      } else {
        signedBlock = signedBlockOrContents as allForks.SignedBeaconBlock;
        signedBlobs = [];
        blockForImport = getBlockInput.preDeneb(config, signedBlock, BlockSource.api);
      }

      // Simple implementation of a pending block queue. Keeping the block here recycles the API logic, and keeps the
      // REST request promise without any extra infrastructure.
      const msToBlockSlot = computeTimeAtSlot(config, signedBlock.message.slot, chain.genesisTime) * 1000 - Date.now();
      if (msToBlockSlot <= MAX_API_CLOCK_DISPARITY_MS && msToBlockSlot > 0) {
        // If block is a bit early, hold it in a promise. Equivalent to a pending queue.
        await sleep(msToBlockSlot);
      }

      // TODO: Validate block
      metrics?.registerBeaconBlock(OpSource.api, seenTimestampSec, blockForImport.block.message);
      const publishPromises = [
        // Send the block, regardless of whether or not it is valid. The API
        // specification is very clear that this is the desired behaviour.
        () => network.gossip.publishBeaconBlockMaybeBlobs(blockForImport) as Promise<unknown>,
        () =>
          chain.processBlock(blockForImport, opts).catch((e) => {
            if (e instanceof BlockError && e.type.code === BlockErrorCode.PARENT_UNKNOWN) {
              network.events.emit(NetworkEvent.unknownBlockParent, {
                blockInput: blockForImport,
                peer: IDENTITY_PEER_ID,
              });
            }
            throw e;
          }),
        // TODO deneb: publish signed blobs as well
      ];
      await promiseAllMaybeAsync(publishPromises);
    },

    async getBlobSidecars(_blockId) {
      // TODO DENEB: Add implementation on the DB structure change PR
      throw Error("");
    },
  };
}
