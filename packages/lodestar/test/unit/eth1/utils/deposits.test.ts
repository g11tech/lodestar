import chai, {expect} from "chai";
import chaiAsPromised from "chai-as-promised";
import {Root, phase0} from "@chainsafe/lodestar-types";
import {List, TreeBacked} from "@chainsafe/ssz";
import {config} from "@chainsafe/lodestar-config/mainnet";
import {verifyMerkleBranch} from "@chainsafe/lodestar-utils";
import {filterBy} from "../../../utils/db";
import {getTreeAtIndex} from "../../../../src/util/tree";
import {generateDepositData, generateDepositEvent} from "../../../utils/deposit";
import {generateState} from "../../../utils/state";
import {
  getDeposits,
  getDepositsWithProofs,
  DepositGetter,
  ErrorDepositIndexTooHigh,
  ErrorNotEnoughDeposits,
} from "../../../../src/eth1/utils/deposits";

chai.use(chaiAsPromised);

describe("eth1 / util / deposits", function () {
  describe("getDeposits", () => {
    interface ITestCase {
      id: string;
      depositCount: number;
      eth1DepositIndex: number;
      depositIndexes: number[];
      expectedReturnedIndexes?: number[];
      error?: any;
    }

    const {MAX_DEPOSITS} = config.params;
    const testCases: ITestCase[] = [
      {
        id: "Return first deposit",
        depositCount: 1,
        eth1DepositIndex: 0,
        depositIndexes: [0, 1, 2, 3],
        expectedReturnedIndexes: [0],
      },
      {
        id: "Return second and third deposit",
        depositCount: 3,
        eth1DepositIndex: 1,
        depositIndexes: [0, 1, 2, 3],
        expectedReturnedIndexes: [1, 2],
      },
      {
        id: "No deposits to be included",
        depositCount: 3,
        eth1DepositIndex: 3,
        depositIndexes: [0, 1, 2, 3],
        expectedReturnedIndexes: [],
      },
      {
        id: "Limit deposits to MAX_DEPOSITS",
        depositCount: 10 * MAX_DEPOSITS,
        eth1DepositIndex: 0,
        depositIndexes: Array.from({length: 10 * MAX_DEPOSITS}, (_, i) => i),
        expectedReturnedIndexes: Array.from({length: MAX_DEPOSITS}, (_, i) => i),
      },
      {
        id: "Should throw if depositIndex > depositCount",
        depositCount: 0,
        eth1DepositIndex: 1,
        depositIndexes: [],
        error: ErrorDepositIndexTooHigh,
      },
      {
        id: "Should throw if DB returns less deposits than expected",
        depositCount: 1,
        eth1DepositIndex: 0,
        depositIndexes: [],
        error: ErrorNotEnoughDeposits,
      },
      {
        id: "Empty case",
        depositCount: 0,
        eth1DepositIndex: 0,
        depositIndexes: [],
        expectedReturnedIndexes: [],
      },
    ];

    for (const testCase of testCases) {
      const {id, depositIndexes, eth1DepositIndex, depositCount, expectedReturnedIndexes, error} = testCase;
      it(id, async function () {
        const state = generateState({eth1DepositIndex});
        const eth1Data = generateEth1Data(depositCount);
        const deposits = depositIndexes.map((index) => generateDepositEvent(index));
        const depositsGetter: DepositGetter<phase0.DepositEvent> = async (indexRange) =>
          filterBy(deposits, indexRange, (deposit) => deposit.index);

        const resultPromise = getDeposits(config, state, eth1Data, depositsGetter);

        if (expectedReturnedIndexes) {
          const result = await resultPromise;
          expect(result.map((deposit) => deposit.index)).to.deep.equal(expectedReturnedIndexes);
        } else if (error) {
          await expect(resultPromise).to.be.rejectedWith(error);
        } else {
          throw Error("Test case must have 'result' or 'error'");
        }
      });
    }
  });

  describe("getDepositsWithProofs", () => {
    it("return empty array if no pending deposits", function () {
      const initialValues = [Buffer.alloc(32)] as List<Root>;
      const depositRootTree = config.types.phase0.DepositDataRootList.tree.createValue(initialValues);
      const depositCount = 0;
      const eth1Data = generateEth1Data(depositCount, depositRootTree);

      const deposits = getDepositsWithProofs(config, [], depositRootTree, eth1Data);
      expect(deposits).to.be.deep.equal([]);
    });

    it("return deposits with valid proofs", function () {
      const depositEvents = Array.from(
        {length: 2},
        (_, index): phase0.DepositEvent => ({
          depositData: generateDepositData(),
          blockNumber: index,
          index,
        })
      );

      const depositRootTree = config.types.phase0.DepositDataRootList.tree.defaultValue();
      for (const depositEvent of depositEvents) {
        depositRootTree.push(config.types.phase0.DepositData.hashTreeRoot(depositEvent.depositData));
      }
      const depositCount = depositEvents.length;
      const eth1Data = generateEth1Data(depositCount, depositRootTree);

      const deposits = getDepositsWithProofs(config, depositEvents, depositRootTree, eth1Data);

      // Should not return all deposits
      expect(deposits.length).to.be.equal(2);

      // Verify each individual merkle root
      for (const [index, deposit] of deposits.entries()) {
        expect(
          verifyMerkleBranch(
            config.types.phase0.DepositData.hashTreeRoot(deposit.data),
            Array.from(deposit.proof).map((p) => p.valueOf() as Uint8Array),
            33,
            index,
            eth1Data.depositRoot.valueOf() as Uint8Array
          ),
          `Wrong merkle proof on deposit ${index}`
        ).to.be.true;
      }
    });
  });
});

function generateEth1Data(depositCount: number, depositRootTree?: TreeBacked<List<Root>>): phase0.Eth1Data {
  return {
    blockHash: Buffer.alloc(32),
    depositRoot: depositRootTree ? getTreeAtIndex(depositRootTree, depositCount - 1).hashTreeRoot() : Buffer.alloc(32),
    depositCount,
  };
}
