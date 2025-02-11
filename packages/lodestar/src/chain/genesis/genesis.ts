/**
 * @module chain/genesis
 */

import {TreeBacked, List} from "@chainsafe/ssz";
import {Root, phase0} from "@chainsafe/lodestar-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {AbortSignal} from "abort-controller";
import {
  getTemporaryBlockHeader,
  getGenesisBeaconState,
  applyDeposits,
  applyTimestamp,
  applyEth1BlockHash,
  isValidGenesisState,
  isValidGenesisValidators,
} from "@chainsafe/lodestar-beacon-state-transition";
import {ILogger} from "@chainsafe/lodestar-utils";
import {IEth1StreamParams, IEth1Provider, getDepositsAndBlockStreamForGenesis, getDepositsStream} from "../../eth1";
import {IGenesisBuilder, IGenesisResult} from "./interface";

export interface IGenesisBuilderKwargs {
  config: IBeaconConfig;
  eth1Provider: IEth1Provider;
  logger: ILogger;

  /** Use to restore pending progress */
  pendingStatus?: {
    state: TreeBacked<phase0.BeaconState>;
    depositTree: TreeBacked<List<Root>>;
    lastProcessedBlockNumber: number;
  };

  signal?: AbortSignal;
  maxBlocksPerPoll?: number;
}

export class GenesisBuilder implements IGenesisBuilder {
  // Expose state to persist on error
  state: TreeBacked<phase0.BeaconState>;
  depositTree: TreeBacked<List<Root>>;
  /** Is null if no block has been processed yet */
  lastProcessedBlockNumber: number | null = null;

  private readonly config: IBeaconConfig;
  private readonly eth1Provider: IEth1Provider;
  private readonly logger: ILogger;
  private readonly signal?: AbortSignal;
  private readonly eth1Params: IEth1StreamParams;
  private readonly depositCache = new Set<number>();
  private readonly fromBlock: number;
  private readonly logEvery = 30 * 1000;
  private lastLog = 0;

  constructor({config, eth1Provider, logger, signal, pendingStatus, maxBlocksPerPoll}: IGenesisBuilderKwargs) {
    this.config = config;
    this.eth1Provider = eth1Provider;
    this.logger = logger;
    this.signal = signal;
    this.eth1Params = {
      ...config.params,
      maxBlocksPerPoll: maxBlocksPerPoll || 10000,
    };

    if (pendingStatus) {
      this.logger.info("Restoring pending genesis state", {block: pendingStatus.lastProcessedBlockNumber});
      this.state = pendingStatus.state;
      this.depositTree = pendingStatus.depositTree;
      this.fromBlock = Math.max(pendingStatus.lastProcessedBlockNumber + 1, this.eth1Provider.deployBlock);
    } else {
      this.state = getGenesisBeaconState(
        config,
        config.types.phase0.Eth1Data.defaultValue(),
        getTemporaryBlockHeader(config, config.types.phase0.BeaconBlock.defaultValue())
      );
      this.depositTree = config.types.phase0.DepositDataRootList.tree.defaultValue();
      this.fromBlock = this.eth1Provider.deployBlock;
    }
  }

  /**
   * Get eth1 deposit events and blocks and apply to this.state until we found genesis.
   */
  async waitForGenesis(): Promise<IGenesisResult> {
    await this.eth1Provider.validateContract();

    // Load data from data from this.db.depositData, this.db.depositDataRoot
    // And start from a more recent fromBlock
    const blockNumberValidatorGenesis = await this.waitForGenesisValidators();

    const depositsAndBlocksStream = getDepositsAndBlockStreamForGenesis(
      blockNumberValidatorGenesis,
      this.eth1Provider,
      this.eth1Params,
      this.signal
    );

    for await (const [depositEvents, block] of depositsAndBlocksStream) {
      this.applyDeposits(depositEvents);
      applyTimestamp(this.config, this.state, block.timestamp);
      applyEth1BlockHash(this.config, this.state, block.blockHash);
      this.lastProcessedBlockNumber = block.blockNumber;

      if (isValidGenesisState(this.config, this.state)) {
        this.logger.info("Found genesis state", {blockNumber: block.blockNumber});
        return {
          state: this.state,
          depositTree: this.depositTree,
          block,
        };
      } else {
        this.throttledLog(`Waiting for min genesis time ${block.timestamp} / ${this.config.params.MIN_GENESIS_TIME}`);
      }
    }

    throw Error("depositsStream stopped without a valid genesis state");
  }

  /**
   * First phase of waiting for genesis.
   * Stream deposits events in batches as big as possible without querying block data
   * @returns Block number at which there are enough active validators is state for genesis
   */
  private async waitForGenesisValidators(): Promise<number> {
    const depositsStream = getDepositsStream(this.fromBlock, this.eth1Provider, this.eth1Params, this.signal);

    for await (const {depositEvents, blockNumber} of depositsStream) {
      this.applyDeposits(depositEvents);
      this.lastProcessedBlockNumber = blockNumber;

      if (isValidGenesisValidators(this.config, this.state)) {
        this.logger.info("Found enough genesis validators", {blockNumber});
        return blockNumber;
      } else {
        this.throttledLog(
          `Found ${this.state.validators.length} / ${this.config.params.MIN_GENESIS_ACTIVE_VALIDATOR_COUNT} validators to genesis`
        );
      }
    }

    throw Error("depositsStream stopped without a valid genesis state");
  }

  private applyDeposits(depositEvents: phase0.DepositEvent[]): void {
    const newDeposits = depositEvents
      .filter((depositEvent) => !this.depositCache.has(depositEvent.index))
      .map((depositEvent) => {
        this.depositCache.add(depositEvent.index);
        this.depositTree.push(this.config.types.phase0.DepositData.hashTreeRoot(depositEvent.depositData));
        return {
          proof: this.depositTree
            .tree()
            .getSingleProof(this.depositTree.type().tree.gindexOfProperty(depositEvent.index)),
          data: depositEvent.depositData,
        };
      });

    applyDeposits(this.config, this.state, newDeposits, this.depositTree);

    // TODO: If necessary persist deposits here to this.db.depositData, this.db.depositDataRoot
  }

  /** Throttle genesis generation status log to prevent spamming */
  private throttledLog(message: string): void {
    if (Date.now() - this.lastLog > this.logEvery) {
      this.lastLog = Date.now();
      this.logger.info(message);
    }
  }
}
