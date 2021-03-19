/**
 * @module tasks used for running tasks on specific events
 */

import {phase0} from "@chainsafe/lodestar-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {ILogger} from "@chainsafe/lodestar-utils";

import {IBeaconDb} from "../db/api";
import {ChainEvent, IBeaconChain} from "../chain";
import {ArchiveBlocksTask} from "./tasks/archiveBlocks";
import {StatesArchiver} from "./tasks/archiveStates";
import {InteropSubnetsJoiningTask} from "./tasks/interopSubnetsJoiningTask";
import {INetwork, NetworkEvent} from "../network";
import {GENESIS_SLOT} from "@chainsafe/lodestar-params";
import {IArchivingStatus, ITaskService} from "./interface";

/**
 * Minimum number of epochs between archived states
 */
export const MIN_EPOCHS_PER_DB_STATE = 1024;

export interface ITasksModules {
  db: IBeaconDb;
  logger: ILogger;
  chain: IBeaconChain;
  network: INetwork;
}

/**
 * Used for running tasks that depends on some events or are executed
 * periodically.
 */
export class TasksService implements ITaskService {
  private readonly config: IBeaconConfig;
  private readonly db: IBeaconDb;
  private readonly chain: IBeaconChain;
  private readonly network: INetwork;
  private readonly logger: ILogger;

  private readonly statesArchiver: StatesArchiver;
  private readonly blockArchiver: ArchiveBlocksTask;
  private readonly interopSubnetsTask: InteropSubnetsJoiningTask;

  constructor(config: IBeaconConfig, modules: ITasksModules) {
    this.config = config;
    this.db = modules.db;
    this.chain = modules.chain;
    this.logger = modules.logger;
    this.network = modules.network;
    this.statesArchiver = new StatesArchiver(this.config, modules);
    this.blockArchiver = new ArchiveBlocksTask(this.config, {
      db: this.db,
      forkChoice: this.chain.forkChoice,
      logger: this.logger,
    });
    this.interopSubnetsTask = new InteropSubnetsJoiningTask(this.config, {
      chain: this.chain,
      network: this.network,
      logger: this.logger,
    });
  }

  async start(): Promise<void> {
    const lastFinalizedSlot = (await this.db.blockArchive.lastKey()) ?? GENESIS_SLOT;
    this.blockArchiver.init(lastFinalizedSlot);
    this.chain.emitter.on(ChainEvent.forkChoiceFinalized, this.onFinalizedCheckpoint);
    this.chain.emitter.on(ChainEvent.checkpoint, this.onCheckpoint);
    this.network.gossip.on(NetworkEvent.gossipStart, this.handleGossipStart);
    this.network.gossip.on(NetworkEvent.gossipStop, this.handleGossipStop);
  }

  async stop(): Promise<void> {
    this.chain.emitter.off(ChainEvent.forkChoiceFinalized, this.onFinalizedCheckpoint);
    this.chain.emitter.off(ChainEvent.checkpoint, this.onCheckpoint);
    this.network.gossip.off(NetworkEvent.gossipStart, this.handleGossipStart);
    this.network.gossip.off(NetworkEvent.gossipStop, this.handleGossipStop);
    this.interopSubnetsTask.stop();
    // Archive latest finalized state
    await this.statesArchiver.archiveState(this.chain.getFinalizedCheckpoint());
  }

  getBlockArchivingStatus(): IArchivingStatus {
    return this.blockArchiver.getArchivingStatus();
  }

  async waitForBlockArchiver(): Promise<void> {
    return await this.blockArchiver.waitUntilComplete();
  }

  private handleGossipStart = (): void => {
    this.interopSubnetsTask.start();
  };

  private handleGossipStop = (): void => {
    this.interopSubnetsTask.stop();
  };

  private onFinalizedCheckpoint = async (finalized: phase0.Checkpoint): Promise<void> => {
    try {
      await this.blockArchiver.run(finalized);
      // should be after ArchiveBlocksTask to handle restart cleanly
      await this.statesArchiver.maybeArchiveState(finalized);

      await Promise.all([
        this.chain.checkpointStateCache.pruneFinalized(finalized.epoch),
        this.chain.stateCache.deleteAllBeforeEpoch(finalized.epoch),
        this.db.attestation.pruneFinalized(finalized.epoch),
        this.db.aggregateAndProof.pruneFinalized(finalized.epoch),
      ]);

      // tasks rely on extended fork choice
      this.chain.forkChoice.prune(finalized.root);
      this.logger.verbose("Finish processing finalized checkpoint", {epoch: finalized.epoch});
    } catch (e) {
      this.logger.error("Error processing finalized checkpoint", {epoch: finalized.epoch}, e);
    }
  };

  private onCheckpoint = async (): Promise<void> => {
    const headStateRoot = this.chain.forkChoice.getHead().stateRoot;
    await Promise.all([
      this.chain.checkpointStateCache.prune(
        this.chain.forkChoice.getFinalizedCheckpoint().epoch,
        this.chain.forkChoice.getJustifiedCheckpoint().epoch
      ),
      this.chain.stateCache.prune(headStateRoot),
    ]);
  };
}
