import { BigNumber, ethers, providers, utils, Wallet } from "ethers";
import moment, { Moment } from "moment";
import { Inject, Service } from "typedi";
import {
  address,
  balanceOf,
  getAssetAmount,
  getAssetAmountBn,
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
import _ from "lodash";
import { formatUnits, hexZeroPad, parseUnits } from "ethers/lib/utils";
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
  position?: Position;
  nftId?: number;
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

    if (snapshot) {
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
        this.getLogger().info(`current gas price: ${gasPrice.toString()}`);
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
        const { position, nftId } = await this.getLastPosition();
        if (position) {
          outOfRange = await this.checkOutOfRange(position);
        }

        if (adjustLTVRatio || (lastProcessedTimeOver && outOfRange)) {
          this.getLogger().info("start to rebalance");
          await this.rebalance(position, nftId);

          // save the snapshot
          this.lastProcessedTime = moment();

          fs.writeFileSync(
            `${process.cwd()}/snapshot`,
            this.lastProcessedTime.toISOString(),
            { flag: "w+" }
          );
        }
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
  async rebalance(
    oldPosition: Position | undefined,
    nftId: number | undefined
  ) {
    if (oldPosition !== undefined && nftId !== undefined) {
      // exit old positions
      this.getLogger().info("exit position");
      await this.exitPosition(oldPosition, nftId);

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
    }

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
    const data = await aavePool.getUserAccountData(address(this.getWallet()));
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
    const { ltv } = await this.getUserAccountData();
    const below = ltv.toNumber() / 100 < this.options.MIN_LTV_RATIO;
    this.getLogger().info(`current LTV: ${ltv}, below: ${below}`);
    return below;
  }

  /**
   * check if current LTV ratio is under maximum
   */
  async checkLTVAboveMaximum(): Promise<boolean> {
    const { ltv } = await this.getUserAccountData();
    const above = ltv.toNumber() / 100 > this.options.MAX_LTV_RATIO;
    this.getLogger().info(`current LTV: ${ltv}, above: ${above}`);
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
  async getLastPosition(): Promise<PositionWithNftId> {
    const logs = await this.getProvider().getLogs({
      address: ADDRESSES[this.getNetwork()].NonfungiblePositionManager,
      topics: [
        utils.id("Transfer(address,address,uint256)"),
        hexZeroPad(ethers.constants.AddressZero, 32),
        hexZeroPad(address(this.getWallet()), 32),
      ],
    });
    const lastLog = logs.slice(-1)[0];
    if (lastLog === undefined) return { position: undefined, nftId: undefined };
    const [, , tokenId] = lastLog.topics;
    const nftId = +formatUnits(tokenId, 0);
    const position = await this.getPosition(nftId);
    if (!position) return { position: undefined, nftId };
    return {
      position,
      nftId,
    };
  }

  /**
   * check a position is out of desired range
   * @param position;
   * @returns
   */
  async checkOutOfRange(position: Position): Promise<boolean> {
    const immutables = await this.getPoolImmutables();
    const state = await this.getPoolState();

    const lowerRange =
      nearestUsableTick(state.tick, immutables.tickSpacing) -
      immutables.tickSpacing * this.options.REBALANCE_TICKS;
    const higherRange =
      nearestUsableTick(state.tick, immutables.tickSpacing) +
      immutables.tickSpacing * this.options.REBALANCE_TICKS;

    return position.tickLower < lowerRange || position.tickUpper > higherRange;
  }

  /********* UNISWAP MUTATION FUNCTION *********/

  /**
   * exit an old uniswap v3 position
   * @param position
   * @param nftId
   */
  async exitPosition(position: Position, nftId: number) {
    const BASE = this.getBaseAssetToken();
    const QUOTE = this.getQuoteAssetToken();

    const { calldata, value } = NonfungiblePositionManager.removeCallParameters(
      position,
      {
        tokenId: nftId,
        liquidityPercentage: new Percent(100),
        slippageTolerance: new Percent(50, 10_000),
        deadline:
          (
            await this.getWallet().provider.getBlock(
              this.getWallet().provider.getBlockNumber()
            )
          ).timestamp + 200,
        collectOptions: {
          // since we are not dealing with native token,
          // it should be safe here to set the expected
          // amount to 0
          expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(BASE, "0"),
          expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(QUOTE, "0"),
          recipient: address(this.getWallet()),
        },
      }
    );

    await (
      await this.getWallet().sendTransaction({
        to: address(this.getNonFungiblePositionManager()),
        from: address(this.getWallet()),
        data: calldata,
        value: value,
        gasLimit: 210000,
        gasPrice: await this.getGasPrice(),
      })
    ).wait();
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
      address(fromAssetContract),
      await fromAssetContract.decimals(),
      await fromAssetContract.name(),
      await fromAssetContract.symbol()
    );

    const toAssetToken = new Token(
      this.getChainId(),
      address(toAssetContract),
      await toAssetContract.decimals(),
      await toAssetContract.name(),
      await toAssetContract.symbol()
    );

    const route = await router.route(
      CurrencyAmount.fromRawAmount(fromAssetToken, amountFrom.toString()),
      toAssetToken,
      TradeType.EXACT_INPUT,
      {
        recipient: address(this.getWallet()),
        slippageTolerance: new Percent(5, 1000),
        deadline: Math.floor(Date.now() / 1000 + 1800),
      }
    );

    if (route !== null) {
      const transaction = {
        data: route.methodParameters?.calldata,
        to: ADDRESSES[this.getNetwork()].SwapRouter02,
        value: BigNumber.from(route.methodParameters?.value),
        from: address(this.getWallet()),
        gasPrice: BigNumber.from(route.gasPriceWei),
      };

      await (await this.getWallet().sendTransaction(transaction)).wait();
    } else {
      throw new Error("Failed to execute alpha router call");
    }
  }

  async openNewUniV3Position() {
    // atomic swap and add liquidity
    const balanceFrom = await balanceOf(
      this.getQuoteAssetContract(),
      this.getWallet()
    );

    const BASE = this.getBaseAssetToken();
    const QUOTE = this.getQuoteAssetToken();

    const token0Balance = CurrencyAmount.fromRawAmount(BASE, "0");
    const token1Balance = CurrencyAmount.fromRawAmount(
      QUOTE,
      balanceFrom.toString()
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
          recipient: address(this.getWallet()),
          // 0.5% slippage
          slippageTolerance: new Percent(5, 1000),
          deadline: 200,
        },
        addLiquidityOptions: {
          recipient: address(this.getWallet()),
        },
      }
    );

    if (routeToRatioResponse.status == SwapToRatioStatus.SUCCESS) {
      const route = routeToRatioResponse.result;
      const transaction = {
        data: route.methodParameters?.calldata,
        to: ADDRESSES[this.getNetwork()].SwapRouter02,
        value: BigNumber.from(route.methodParameters?.value),
        from: address(this.getWallet()),
        gasPrice: BigNumber.from(route.gasPriceWei),
      };

      await (await this.getWallet().sendTransaction(transaction)).wait();
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
    await (
      await aavePool.repay(
        // asset address
        address(this.getLendingAssetContract()),
        balanceBase,
        // interest mode, using variable one
        2,
        address(this.getWallet())
      )
    ).wait();
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
      await (
        await aavePool.supply(
          address(this.getCollateralAssetContract()),
          balanceCollateral,
          address(this.getWallet()),
          0
        )
      ).wait();
    }

    // open a new loan
    const { availableBorrowsBase } = await this.getUserAccountData();
    const loanAmount = getAssetAmountBn(
      availableBorrowsBase,
      await this.getAssetPriceFromAaveOracle(
        address(this.getLendingAssetContract())
      )
    );
    this.getLogger().info(`borrowing ${loanAmount.toString()} amount of token`);
    await (
      await aavePool.borrow(
        address(this.getLendingAssetContract()),
        parseUnits(loanAmount.toString(), this.getLendingAssetDecimals()),
        // variable mode
        2,
        0,
        address(this.getWallet())
      )
    ).wait();
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
    return this.baseAssetToken;
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
    return this.getProvider().getGasPrice();
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
