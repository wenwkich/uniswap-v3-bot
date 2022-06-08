import {
  BigNumber,
  ethers,
  providers,
  Transaction,
  utils,
  Wallet,
} from "ethers";
import moment, { Moment } from "moment";
import { Inject, Service } from "typedi";
import {
  address,
  balanceOf,
  getAssetAmount,
  getAssetAmountBn,
  MAX_UINT128,
  parseGwei,
  sleep,
} from "../common/utils";
import { LoggerService } from "../log";
import path from "path";
import fs from "fs";
import { BotServiceOptions } from "../common/interfaces";
import erc20ABI from "erc-20-abi";
import COINGECKO_IDS from "../common/coingecko_ids.json";
import ADDRESSES from "../common/addresses.json";
import { NETWORKS } from "../common/network";
import _, { max } from "lodash";
import { formatUnits, hexlify, hexZeroPad, parseUnits } from "ethers/lib/utils";
import { abi as uniPoolAbi } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json";
import { abi as nonFungiblePositionManagerAbi } from "@uniswap/v3-periphery/artifacts/contracts/interfaces/INonfungiblePositionManager.sol/INonfungiblePositionManager.json";
import { abi as aavePoolAbi } from "@aave/core-v3/artifacts/contracts/interfaces/IPool.sol/IPool.json";
import { abi as aaveOracleAbi } from "@aave/core-v3/artifacts/contracts/interfaces/IAaveOracle.sol/IAaveOracle.json";
import {
  nearestUsableTick,
  NonfungiblePositionManager,
  Pool,
  Position,
} from "@uniswap/v3-sdk";
import {
  CurrencyAmount,
  Fraction,
  Percent,
  Token,
  TradeType,
} from "@uniswap/sdk-core";
import { AlphaRouter, SwapToRatioStatus } from "@uniswap/smart-order-router";
import axios from "axios";

interface Immutables {
  factory: string;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
  maxLiquidityPerTick: ethers.BigNumber;
}

interface State {
  liquidity: ethers.BigNumber;
  sqrtPriceX96: ethers.BigNumber;
  tick: number;
  observationIndex: number;
  observationCardinality: number;
  observationCardinalityNext: number;
  feeProtocol: number;
  unlocked: boolean;
}

interface PositionWithNftId {
  position: Position;
  nftId: number;
}

interface UserAccount {
  totalCollateralBase: BigNumber;
  totalDebtBase: BigNumber;
  availableBorrowsBase: BigNumber;
  currentLiquidationThreshold: BigNumber;
  ltv: BigNumber;
  healthFactor: BigNumber;
}

@Service()
export class EthStablePairBotService {
  private provider: ethers.providers.BaseProvider;
  private wallet: ethers.Wallet;
  private options: BotServiceOptions;
  private lastProcessedTime: Moment;

  private poolContract: ethers.Contract;
  private nonFungiblePositionManager: ethers.Contract;
  private aavePoolContract: ethers.Contract;
  private aaveOracleContract: ethers.Contract;

  private quoteAssetContract: ethers.Contract;
  private quoteAssetToken: Token;
  private baseAssetContract: ethers.Contract;
  private baseAssetToken: Token;

  private immutables: Immutables;

  @Inject()
  private readonly loggerService: LoggerService;

  async setup(options: BotServiceOptions): Promise<void> {
    const privKey = process.env.PRIVATE_KEY;
    this.options = options;

    if (!privKey) {
      throw Error("no PRIVATE_KEY is provided");
    }

    if (!NETWORKS[this.getNetwork()]) {
      throw Error("no XXX_PROVIDER_URL is provided");
    }
    this.provider = new ethers.providers.JsonRpcProvider(
      this.getProviderUrl(),
      this.getChainId()
    );
    this.wallet = new Wallet(privKey, this.provider);

    // fetch the last processed time from cwd
    const snapshot = fs.readFileSync(`${process.cwd()}/snapshot`, {
      flag: "w+",
    });

    if (snapshot.toString()) {
      this.lastProcessedTime = moment(snapshot.toString());
    } else {
      this.lastProcessedTime = moment().subtract(
        this.options.MIN_REBALANCE_HOUR,
        "hours"
      );
    }

    // initialize other params
    this.poolContract = new ethers.Contract(
      this.options.POOL_ADDRESS,
      uniPoolAbi,
      this.getWallet()
    );
    this.nonFungiblePositionManager = new ethers.Contract(
      ADDRESSES[this.getNetwork()].NonfungiblePositionManager,
      nonFungiblePositionManagerAbi,
      this.getWallet()
    );
    this.aavePoolContract = new ethers.Contract(
      ADDRESSES[this.getNetwork()].AavePool,
      aavePoolAbi,
      this.getWallet()
    );
    this.aaveOracleContract = new ethers.Contract(
      ADDRESSES[this.getNetwork()].AaveOracle,
      aaveOracleAbi,
      this.getWallet()
    );

    if (this.options.BASE_TOKEN === 0) {
      this.quoteAssetContract = new ethers.Contract(
        this.poolContract.token1(),
        erc20ABI,
        this.getWallet()
      );
      this.baseAssetContract = new ethers.Contract(
        this.poolContract.token0(),
        erc20ABI,
        this.getWallet()
      );
    } else {
      this.quoteAssetContract = new ethers.Contract(
        this.poolContract.token0(),
        erc20ABI,
        this.getWallet()
      );
      this.baseAssetContract = new ethers.Contract(
        this.poolContract.token1(),
        erc20ABI,
        this.getWallet()
      );
    }
    this.quoteAssetToken = new Token(
      this.getChainId(),
      await address(this.quoteAssetContract),
      await this.quoteAssetContract.decimals(),
      await this.quoteAssetContract.name(),
      await this.quoteAssetContract.symbol()
    );
    this.baseAssetToken = new Token(
      this.getChainId(),
      await address(this.baseAssetContract),
      await this.baseAssetContract.decimals(),
      await this.baseAssetContract.name(),
      await this.baseAssetContract.symbol()
    );
  }

  async start(): Promise<void> {
    this.routine();
  }

  async routine() {
    while (true) {
      try {
        const gasPrice = await this.getGasPrice();
        this.getLogger().info(
          `current gas price: ${formatUnits(gasPrice, "gwei")}`
        );
        if (parseGwei(this.options.MAX_GAS_PRICE_GWEI).lt(gasPrice)) {
          this.getLogger().warn("Gas price exeeds limit");
          sleep(this.options.PRICE_CHECK_INTERVAL_SEC);
          continue;
        }

        // will force rebalance if the LTV ratio standard is met
        let adjustLTVRatio = await this.checkLTVBelowMinimum();

        if (!adjustLTVRatio) {
          adjustLTVRatio = await this.checkLTVAboveMaximum();
        }

        // check if the minimum rebalance time is over
        const lastProcessedTimeOver =
          moment()
            .subtract(this.options.MIN_REBALANCE_HOUR, "hours")
            .diff(this.lastProcessedTime) >= 0;

        let outOfRange = false;
        const positions = await this.getLastPositions();

        const maxPosition = await this.getPositionWithMaxLiquidity(positions);
        if (maxPosition) {
          outOfRange = await this.checkOutOfRange(maxPosition.position);
        }

        if (!maxPosition) {
          this.getLogger().info("cannot find a proper position, start over");
        }

        if (adjustLTVRatio) {
          this.getLogger().info(
            "need to adjust loan ratio, force to rebalance"
          );
        }

        if (lastProcessedTimeOver && outOfRange) {
          this.getLogger().info("the position is out of range");
        }
        if (
          !maxPosition ||
          adjustLTVRatio ||
          (lastProcessedTimeOver && outOfRange)
        ) {
          this.getLogger().info("start to rebalance");
          await this.rebalance(positions);

          // save the snapshot
          this.lastProcessedTime = moment();

          fs.writeFileSync(
            `${process.cwd()}/snapshot`,
            this.lastProcessedTime.toISOString(),
            { flag: "w+" }
          );
        } else {
          this.getLogger().info("condition not satisfied, skipping");
        }

        sleep(this.options.PRICE_CHECK_INTERVAL_SEC);
      } catch (err: any) {
        this.getLogger().error(err);
      }
    }
  }

  /**
   * main logic to rebalance
   * @param oldPosition
   * @param nftId
   */
  async rebalance(oldPositions: PositionWithNftId[]) {
    // exit old positions
    this.getLogger().info("exit all old positions");
    await Promise.all(
      _.map(oldPositions, async (pos) => {
        const { position, nftId } = pos;
        if ((position.liquidity as any) > 0) {
          await this.exitPosition(position, nftId);
        }
      })
    );

    // swap the remaining base asset to quote asset first
    this.getLogger().info("swap the remaining base asset to quote asset");
    await this.attemptToSwapAll(
      this.getBaseAssetContract(),
      this.getQuoteAssetContract(),
      this.getBaseAssetDecimals(),
      0,
      await this.getBaseAssetPriceUsd()
    );

    // repay loan
    this.getLogger().info("repay loan");
    await this.repayLoan();

    // swap remaining profit to stablecoin
    this.getLogger().info(
      "swap the remaining quote base asset to collateral asset"
    );
    await this.attemptToSwapAll(
      this.getQuoteAssetContract(),
      this.getCollateralAssetContract(),
      this.getQuoteAssetDecimals(),
      0,
      await this.getQuoteAssetPriceUsd()
    );

    // open new loan
    this.getLogger().info("open new loan");
    await this.openNewLoan();

    // open new uniswap v3 position
    this.getLogger().info("open new v3 position");
    await this.openNewUniV3Position();
  }

  /********* STATUS CHECK FUNCTION *********/

  async getUserAccountData(): Promise<UserAccount> {
    const aavePool = this.getAavePoolContract();
    const data = await aavePool.getUserAccountData(
      await address(this.getWallet())
    );
    return {
      totalCollateralBase: data[0],
      totalDebtBase: data[1],
      availableBorrowsBase: data[2],
      currentLiquidationThreshold: data[3],
      ltv: data[4],
      healthFactor: data[5],
    };
  }

  async getAssetPriceFromAaveOracle(assetAddress: string): Promise<BigNumber> {
    const aaveOracle = this.getAaveOracleContract();
    return aaveOracle.getAssetPrice(assetAddress);
  }

  /**
   * check if current LTV ratio is under minimum
   */
  async checkLTVBelowMinimum(): Promise<boolean> {
    const { totalCollateralBase, totalDebtBase } =
      await this.getUserAccountData();
    const ltv = totalDebtBase.mul(10000).div(totalCollateralBase);
    const below = ltv.toNumber() / 10000 < this.options.MIN_LTV_RATIO;
    this.getLogger().info(
      `current LTV: ${ltv.toNumber() / 10000}, below: ${below}`
    );
    return below;
  }

  /**
   * check if current LTV ratio is under maximum
   */
  async checkLTVAboveMaximum(): Promise<boolean> {
    const { totalCollateralBase, totalDebtBase } =
      await this.getUserAccountData();
    const ltv = totalDebtBase.mul(10000).div(totalCollateralBase);
    const above = ltv.toNumber() / 10000 > this.options.MAX_LTV_RATIO;
    this.getLogger().info(
      `current LTV: ${ltv.toNumber() / 10000}, above: ${above}`
    );
    return above;
  }

  async getPoolImmutables() {
    if (this.immutables) return this.immutables;

    const poolContract = this.getPoolContract();
    this.immutables = {
      factory: await poolContract.factory(),
      token0: await poolContract.token0(),
      token1: await poolContract.token1(),
      fee: await poolContract.fee(),
      tickSpacing: await poolContract.tickSpacing(),
      maxLiquidityPerTick: await poolContract.maxLiquidityPerTick(),
    };
    return this.immutables;
  }

  async getPoolState() {
    const poolContract = this.getPoolContract();
    const slot = await poolContract.slot0();
    const PoolState: State = {
      liquidity: await poolContract.liquidity(),
      sqrtPriceX96: slot[0],
      tick: slot[1],
      observationIndex: slot[2],
      observationCardinality: slot[3],
      observationCardinalityNext: slot[4],
      feeProtocol: slot[5],
      unlocked: slot[6],
    };
    return PoolState;
  }

  async getPosition(nftId: number): Promise<Position | undefined> {
    const nonFungiblePositionManager = this.getNonFungiblePositionManager();
    const positionRaw = await nonFungiblePositionManager.positions(nftId);

    const tickLower = positionRaw[5];
    const tickUpper = positionRaw[6];
    const liquidity = positionRaw[7];

    if (liquidity.eq(0)) return undefined;

    const immutables = await this.getPoolImmutables();
    const state = await this.getPoolState();

    const BASE = this.getBaseAssetToken();
    const QUOTE = this.getQuoteAssetToken();

    const POOL = new Pool(
      BASE,
      QUOTE,
      immutables.fee,
      state.sqrtPriceX96.toString(),
      state.liquidity.toString(),
      state.tick
    );

    return new Position({
      pool: POOL,
      liquidity,
      tickLower,
      tickUpper,
    });
  }

  /**
   * get last position
   */
  async getLastPositions(): Promise<PositionWithNftId[]> {
    const manager = await this.getNonFungiblePositionManager();

    const balance = await manager.balanceOf(await address(this.getWallet()));
    if (balance === 0) return [];

    return await _.reduce(
      _.range(0, balance),
      async (prev, curr, index) => {
        const prevRes = await prev;
        const tokenId = await manager.tokenOfOwnerByIndex(
          await address(this.getWallet()),
          curr
        );
        const nftId = +formatUnits(tokenId, 0);
        const position = await this.getPosition(nftId);

        if (!position) return [...prevRes];

        return [
          ...prevRes,
          {
            position,
            nftId,
          },
        ];
      },
      Promise.resolve([] as PositionWithNftId[])
    );
  }

  async getPositionWithMaxLiquidity(positions: PositionWithNftId[]) {
    return _.maxBy(positions, (pos) => {
      return pos.position.liquidity;
    });
  }

  /**
   * check a position is out of desired range
   * @param position;
   * @returns
   */
  async checkOutOfRange(position: Position): Promise<boolean> {
    const state = await this.getPoolState();
    return position.tickLower > state.tick || position.tickUpper < state.tick;
  }

  /**
   * get the fee collected
   */
  async getFees(nftId: number) {
    const positionManager = this.getNonFungiblePositionManager();
    const { amount0, amount1 } = await positionManager.callStatic.collect(
      {
        tokenId: hexlify(nftId),
        recipient: address(this.getWallet()), // some tokens might fail if transferred to address(0)
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
      { from: address(this.getWallet()) } // need to simulate the call as the owner
    );
    return { amount0, amount1 };
  }

  /********* UNISWAP MUTATION FUNCTION *********/

  /**
   * exit an old uniswap v3 position
   * @param position
   * @param nftId
   */
  async exitPosition(position: Position, nftId: number) {
    this.getLogger().info(`exiting position with nftId ${nftId}`);
    const BASE = this.getBaseAssetToken();
    const QUOTE = this.getQuoteAssetToken();

    const { amount0, amount1 } = await this.getFees(nftId);
    this.getLogger().info(`getting fee0: ${amount0}, fee1: ${amount1}`);
    const { calldata, value } = NonfungiblePositionManager.removeCallParameters(
      position,
      {
        tokenId: hexlify(nftId),
        // remove all liquidity
        liquidityPercentage: new Percent(1),
        slippageTolerance: new Percent(10, 1000),
        deadline:
          (
            await this.getWallet().provider.getBlock(
              this.getWallet().provider.getBlockNumber()
            )
          ).timestamp + 1200,
        collectOptions: {
          expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(
            BASE,
            amount0.toString()
          ),
          expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(
            QUOTE,
            amount1.toString()
          ),
          recipient: await address(this.getWallet()),
        },
      }
    );

    await this.waitForTransaction(
      await this.getWallet().sendTransaction({
        to: await address(this.getNonFungiblePositionManager()),
        from: await address(this.getWallet()),
        data: calldata,
        value: value,
        gasLimit: 330000,
        gasPrice: await this.getGasPrice(),
      })
    );
  }

  /**
   * swap all the asset if the balance is greater than certain limit
   * @param fromAssetContract
   * @param toAssetContract
   * @param fromAssetDecimals
   * @param limitUsd
   * @param priceUsd
   */
  async attemptToSwapAll(
    fromAssetContract: ethers.Contract,
    toAssetContract: ethers.Contract,
    fromAssetDecimals: number,
    limitUsd: number,
    priceUsd: number
  ) {
    const balanceFrom = await balanceOf(fromAssetContract, this.getWallet());
    this.getLogger().info(`balance original: ${balanceFrom.toString()}`);
    if (
      balanceFrom.gt(
        parseUnits("" + getAssetAmount(limitUsd, priceUsd), fromAssetDecimals)
      )
    ) {
      await this.swapTo(fromAssetContract, toAssetContract, balanceFrom);
    }
  }

  /**
   * use alpha router to swap asset to another
   * @param fromAssetContract
   * @param toAssetContract
   * @param amountFrom
   */
  async swapTo(
    fromAssetContract: ethers.Contract,
    toAssetContract: ethers.Contract,
    amountFrom: BigNumber
  ) {
    const router = new AlphaRouter({
      chainId: this.getChainId(),
      provider: this.getProvider(),
    });

    const fromAssetToken = new Token(
      this.getChainId(),
      await address(fromAssetContract),
      await fromAssetContract.decimals(),
      await fromAssetContract.name(),
      await fromAssetContract.symbol()
    );

    const toAssetToken = new Token(
      this.getChainId(),
      await address(toAssetContract),
      await toAssetContract.decimals(),
      await toAssetContract.name(),
      await toAssetContract.symbol()
    );

    const route = await router.route(
      CurrencyAmount.fromRawAmount(fromAssetToken, amountFrom.toString()),
      toAssetToken,
      TradeType.EXACT_INPUT,
      {
        recipient: await address(this.getWallet()),
        slippageTolerance: new Percent(5, 1000),
        deadline:
          (
            await this.getWallet().provider.getBlock(
              this.getWallet().provider.getBlockNumber()
            )
          ).timestamp + 1200,
      }
    );

    if (route !== null) {
      const transaction = {
        data: route.methodParameters?.calldata,
        to: ADDRESSES[this.getNetwork()].SwapRouter02,
        value: BigNumber.from(route.methodParameters?.value),
        from: await address(this.getWallet()),
        gasPrice: await this.getGasPrice(),
      };

      await this.waitForTransaction(
        await this.getWallet().sendTransaction(transaction)
      );
    } else {
      throw new Error("Failed to execute alpha router call");
    }
  }

  async openNewUniV3Position() {
    // atomic swap and add liquidity
    const balanceBase = await balanceOf(
      this.getBaseAssetContract(),
      this.getWallet()
    );
    const balanceQuote = await balanceOf(
      this.getQuoteAssetContract(),
      this.getWallet()
    );
    this.getLogger().info(`token0 balance: ${balanceBase}`);
    this.getLogger().info(`token1 balance: ${balanceQuote}`);

    const BASE = this.getBaseAssetToken();
    const QUOTE = this.getQuoteAssetToken();

    const token0Balance = CurrencyAmount.fromRawAmount(
      BASE,
      balanceBase.toString()
    );
    const token1Balance = CurrencyAmount.fromRawAmount(
      QUOTE,
      balanceQuote.toString()
    );
    const immutables = await this.getPoolImmutables();
    const state = await this.getPoolState();

    const pool = new Pool(
      BASE,
      QUOTE,
      immutables.fee,
      state.sqrtPriceX96.toString(),
      state.liquidity.toString(),
      state.tick
    );

    const router = new AlphaRouter({
      chainId: this.getChainId(),
      provider: this.getProvider(),
    });

    const routeToRatioResponse = await router.routeToRatio(
      token0Balance,
      token1Balance,
      new Position({
        pool,
        tickLower:
          nearestUsableTick(state.tick, immutables.tickSpacing) -
          immutables.tickSpacing * this.options.RANGE_TICKS,
        tickUpper:
          nearestUsableTick(state.tick, immutables.tickSpacing) +
          immutables.tickSpacing * this.options.RANGE_TICKS,
        // since liquidity is unknown,
        // it will be set inside the routeToRatio call
        liquidity: 1,
      }),
      {
        ratioErrorTolerance: new Fraction(1, 100),
        maxIterations: 6,
      },
      {
        swapOptions: {
          recipient: await address(this.getWallet()),
          // 1% slippage
          slippageTolerance: new Percent(7, 1000),
          deadline:
            (
              await this.getWallet().provider.getBlock(
                this.getWallet().provider.getBlockNumber()
              )
            ).timestamp + 1200,
        },
        addLiquidityOptions: {
          recipient: await address(this.getWallet()),
        },
      }
    );

    if (routeToRatioResponse.status == SwapToRatioStatus.SUCCESS) {
      const route = routeToRatioResponse.result;
      const transaction = {
        data: route.methodParameters?.calldata,
        to: ADDRESSES[this.getNetwork()].SwapRouter02,
        value: BigNumber.from(route.methodParameters?.value),
        from: await address(this.getWallet()),
        gasPrice: await this.getGasPrice(),
      };

      await this.waitForTransaction(
        await this.getWallet().sendTransaction(transaction)
      );
    } else {
      throw new Error(
        "Failed to execute alpha router call, status: " +
          routeToRatioResponse.status
      );
    }
  }

  /********* AAVE MUTATION FUNCTION *********/
  async repayLoan() {
    const aavePool = await this.getAavePoolContract();

    const { totalDebtBase } = await this.getUserAccountData();

    if (totalDebtBase.lt(0)) return;

    const balanceBase = await balanceOf(
      this.getLendingAssetContract(),
      this.getWallet()
    );

    this.getLogger().info(`repaying ${balanceBase.toString()} amount of token`);

    if (balanceBase.lte(0)) return;
    await this.waitForTransaction(
      await aavePool.repay(
        // asset address
        await address(this.getLendingAssetContract()),
        balanceBase,
        // interest mode, using variable one
        2,
        await address(this.getWallet()),
        { gasPrice: await this.getGasPrice() }
      )
    );
  }

  async openNewLoan() {
    const aavePool = await this.getAavePoolContract();

    // if there is new USDC, deposit
    const balanceCollateral = await balanceOf(
      this.getCollateralAssetContract(),
      this.getWallet()
    );

    if (balanceCollateral.gt(0)) {
      this.getLogger().info(
        `depositing ${balanceCollateral.toString()} amount of token`
      );
      await this.waitForTransaction(
        await aavePool.supply(
          await address(this.getCollateralAssetContract()),
          balanceCollateral,
          await address(this.getWallet()),
          0,
          { gasPrice: await this.getGasPrice() }
        )
      );
    }

    // open a new loan
    const { availableBorrowsBase } = await this.getUserAccountData();
    const price = await this.getAssetPriceFromAaveOracle(
      await address(this.getLendingAssetContract())
    );
    const loanAmount = parseUnits(
      getAssetAmountBn(
        availableBorrowsBase.mul(1000000).mul(95).div(100),
        price
      ).toString(),
      this.getLendingAssetDecimals()
    ).div(1000000);

    this.getLogger().info(`loan amount: ${loanAmount.toString()}`);
    await this.waitForTransaction(
      await aavePool.borrow(
        await address(this.getLendingAssetContract()),
        loanAmount,
        // variable mode
        2,
        0,
        await address(this.getWallet()),
        { gasPrice: await this.getGasPrice() }
      )
    );
  }

  getPoolContract(): ethers.Contract {
    return this.poolContract;
  }

  getNonFungiblePositionManager(): ethers.Contract {
    return this.nonFungiblePositionManager;
  }

  getAavePoolContract(): ethers.Contract {
    return this.aavePoolContract;
  }

  getAaveOracleContract(): ethers.Contract {
    return this.aaveOracleContract;
  }

  getQuoteAssetContract(): ethers.Contract {
    return this.quoteAssetContract;
  }

  getQuoteAssetDecimals(): number {
    return this.quoteAssetToken.decimals;
  }

  getQuoteAssetToken(): Token {
    return this.quoteAssetToken;
  }

  getBaseAssetContract(): ethers.Contract {
    return this.baseAssetContract;
  }

  getBaseAssetDecimals(): number {
    return this.baseAssetToken.decimals;
  }

  getBaseAssetToken(): Token {
    return this.baseAssetToken;
  }

  getLendingAssetContract(): ethers.Contract {
    if (this.options.LENDING_TOKEN === "base") {
      return this.getBaseAssetContract();
    } else if (this.options.LENDING_TOKEN === "quote") {
      return this.getQuoteAssetContract();
    }
    throw new Error("Other type of asset are not implemented");
  }

  getCollateralAssetContract(): ethers.Contract {
    if (this.options.COLLATERAL_TOKEN === "base") {
      return this.getBaseAssetContract();
    } else if (this.options.LENDING_TOKEN === "quote") {
      return this.getQuoteAssetContract();
    }
    throw new Error("Other type of asset are not implemented");
  }

  getLendingAssetDecimals(): number {
    if (this.options.LENDING_TOKEN === "base") {
      return this.getBaseAssetDecimals();
    } else if (this.options.LENDING_TOKEN === "quote") {
      return this.getQuoteAssetDecimals();
    }
    throw new Error("Other type of asset are not implemented");
  }

  getCollateralAssetDecimals(): number {
    if (this.options.COLLATERAL_TOKEN === "base") {
      return this.getBaseAssetDecimals();
    } else if (this.options.LENDING_TOKEN === "quote") {
      return this.getQuoteAssetDecimals();
    }
    throw new Error("Other type of asset are not implemented");
  }

  async getLendingAssetPriceUsd(): Promise<number> {
    if (this.options.LENDING_TOKEN === "base") {
      return this.getBaseAssetPriceUsd();
    } else if (this.options.LENDING_TOKEN === "quote") {
      return this.getQuoteAssetPriceUsd();
    }
    throw new Error("Other type of asset are not implemented");
  }

  async getCollateralAssetPriceUsd(): Promise<number> {
    if (this.options.COLLATERAL_TOKEN === "base") {
      return this.getBaseAssetPriceUsd();
    } else if (this.options.LENDING_TOKEN === "quote") {
      return this.getQuoteAssetPriceUsd();
    }
    throw new Error("Other type of asset are not implemented");
  }

  async getQuoteAssetPriceUsd(): Promise<number> {
    const resp = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${
        COINGECKO_IDS[
          this.options.QUOTE_TOKEN_NAME as keyof typeof COINGECKO_IDS
        ]
      }`
    );
    return resp.data.market_data.current_price.usd;
  }

  async getBaseAssetPriceUsd(): Promise<number> {
    // hard code to 1
    return 1;
  }

  async getGasPrice(): Promise<BigNumber> {
    const oldGasPrice = await this.getProvider().getGasPrice();
    const newGasPrice = oldGasPrice.mul(2);
    return newGasPrice;
  }

  async waitForTransaction(tx: Transaction) {
    const hash = tx.hash;

    if (hash) {
      await this.provider.waitForTransaction(
        hash,
        1,
        this.options.TRANSACTION_TIMEOUT_SEC * 1000
      );
    }
  }

  getNetwork() {
    return this.options.NETWORK;
  }

  getWallet() {
    return this.wallet;
  }

  getProvider() {
    return this.provider;
  }

  getChainId() {
    return NETWORKS[this.getNetwork()].chainId;
  }

  getProviderUrl() {
    return NETWORKS[this.getNetwork()].url;
  }

  getLogger() {
    return this.loggerService.getLogger();
  }
}
