import { BigNumber, ethers, providers, utils, Wallet } from "ethers";
import moment, { Moment } from "moment";
import { Inject, Service } from "typedi";
import {
  address,
  balanceOf,
  getAssetAmount,
  parseGwei,
  sleep,
} from "../common/utils";
import { LoggerService } from "../log";
import path from "path";
import fs from "fs";
import { BotServiceOptions } from "../common/interfaces";
import { erc20ABI } from "wagmi";
import COINGECKO_IDS from "../common/coingecko_ids.json";
import ADDRESSES from "../common/addresses.json";
import { NETWORKS } from "../common/network";
import _ from "lodash";
import { formatUnits, hexZeroPad, parseUnits } from "ethers/lib/utils";
import { abi as uniPoolAbi } from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json";
import { abi as nonFungiblePositionManagerAbi } from "@uniswap/v3-periphery/artifacts/contracts/interfaces/INonfungiblePositionManager.sol/INonfungiblePositionManager.json";
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

@Service()
export class EthStablePairBotService {
  private provider: ethers.providers.BaseProvider;
  private wallet: ethers.Wallet;
  private options: BotServiceOptions;
  private lastProcessedTime: Moment;

  private poolContract: ethers.Contract;
  private nonFungiblePositionManager: ethers.Contract;

  private quoteAssetContract: ethers.Contract;
  private quoteAssetToken: Token;
  private baseAssetContract: ethers.Contract;
  private baseAssetToken: Token;
  private stablecoinContract: ethers.Contract;
  private stablecoinDecimals: number;

  private immutables: Immutables;

  @Inject()
  private readonly loggerService: LoggerService;

  async setup(options: BotServiceOptions): Promise<void> {
    const privKey = process.env.PRIVATE_KEY;
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
    this.options = options;

    // fetch the last processed time from cwd
    const snapshot = fs.readFileSync(
      `${path.basename(process.cwd())}./snapshot`,
      {
        flag: "w+",
      }
    );

    if (snapshot) {
      this.lastProcessedTime = moment(snapshot.toString());
    } else {
      this.lastProcessedTime = moment(0);
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
      address(this.quoteAssetContract),
      await this.quoteAssetContract.decimals(),
      await this.quoteAssetContract.name(),
      await this.quoteAssetContract.symbol()
    );
    this.baseAssetToken = new Token(
      this.getChainId(),
      address(this.baseAssetContract),
      await this.baseAssetContract.decimals(),
      await this.baseAssetContract.name(),
      await this.baseAssetContract.symbol()
    );

    this.stablecoinContract = new ethers.Contract(
      ADDRESSES[this.getNetwork()].USDC,
      erc20ABI,
      this.getWallet()
    );
    this.stablecoinDecimals = await this.stablecoinContract.decimals();
  }

  async start(): Promise<void> {
    this.routine();
  }

  async routine() {
    while (true) {
      try {
        const gasPrice = await this.getGasPrice();
        if (parseGwei(this.options.MAX_GAS_PRICE_GWEI).gt(gasPrice)) {
          this.getLogger().warn("Gas price exeeds limit");
          sleep(this.options.PRICE_CHECK_INTERVAL_SEC);
          continue;
        }

        // will force rebalance if the LTV ratio standard is met
        let adjustLTVRatio = await this.checkLTVBelowMinimum();

        if (adjustLTVRatio) {
          adjustLTVRatio = await this.checkLTVAboveMaximum();
        }

        // check if the minimum rebalance time is over
        const lastProcessedTimeOver =
          moment()
            .subtract(this.options.MIN_REBALANCE_HOUR, "hours")
            .diff(this.lastProcessedTime) > 0;

        let outOfRange = false;
        const activePosition = await this.getLastPosition();
        if (activePosition) {
          outOfRange = await this.checkOutOfRange(activePosition);
        }

        if (adjustLTVRatio || (lastProcessedTimeOver && outOfRange)) {
          await this.rebalance(activePosition);
        }

        // save the snapshot
        this.lastProcessedTime = moment();

        fs.writeFileSync(
          `${path.basename(process.cwd())}./snapshot`,
          this.lastProcessedTime.toISOString(),
          { flag: "w+" }
        );
      } catch (err: any) {
        this.getLogger().error(err);
      }
    }
  }

  /**
   * check if current LTV ratio is under minimum
   */
  async checkLTVBelowMinimum(): Promise<boolean> {
    // TODO:
    return Promise.resolve(false);
  }

  /**
   * check if current LTV ratio is under maximum
   */
  async checkLTVAboveMaximum(): Promise<boolean> {
    // TODO:
    return Promise.resolve(false);
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
  async getLastPosition(): Promise<Position | undefined> {
    const logs = await this.getProvider().getLogs({
      address: ADDRESSES[this.getNetwork()].NonfungiblePositionManager,
      topics: [
        utils.id("Transfer(address,address,uint256)"),
        hexZeroPad(ethers.constants.AddressZero, 32),
        hexZeroPad(address(this.getWallet()), 32),
      ],
    });
    const lastLog = logs.slice(-1)[0];
    if (lastLog === undefined) return Promise.resolve(undefined);
    const [, , tokenId] = lastLog.topics;
    return this.getPosition(+formatUnits(tokenId, 0));
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

  async rebalance(oldPosition: Position | undefined) {
    if (oldPosition !== undefined) {
      // exit old positions
      await this.exitPosition(oldPosition);

      // swap the remaining base asset to quote asset first
      await this.attemptToSwapAll(
        this.getBaseAssetContract(),
        this.getQuoteAssetContract(),
        this.getBaseAssetDecimals(),
        0,
        await this.getBaseAssetPriceUsd()
      );

      // repay loan
      const balanceBase = await balanceOf(
        this.getBaseAssetContract(),
        this.getWallet()
      );
      await this.repayLoan(balanceBase);

      // swap remaining profit to stablecoin
      await this.attemptToSwapAll(
        this.getQuoteAssetContract(),
        this.getStablecoinContract(),
        this.getQuoteAssetDecimals(),
        0,
        await this.getQuoteAssetPriceUsd()
      );
    }

    // open new loan
    await this.openNewLoan();

    // open new uniswap v3 position
    await this.openNewUniV3Position();
  }

  async exitPosition(position: Position) {
    const BASE = this.getBaseAssetToken();
    const QUOTE = this.getQuoteAssetToken();

    const { calldata, value } = NonfungiblePositionManager.removeCallParameters(
      position,
      {
        tokenId: 1,
        liquidityPercentage: new Percent(100),
        slippageTolerance: new Percent(50, 10_000),
        deadline:
          (
            await this.getWallet().provider.getBlock(
              this.getWallet().provider.getBlockNumber()
            )
          ).timestamp + 200,
        collectOptions: {
          // TODO: check if this should be 0
          expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(BASE, "0"),
          expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(QUOTE, "0"),
          recipient: address(this.getWallet()),
        },
      }
    );

    this.getWallet().sendTransaction({
      to: address(this.getNonFungiblePositionManager()),
      from: address(this.getWallet()),
      data: calldata,
      value: value,
      gasLimit: 1000000,
      gasPrice: await this.getGasPrice(),
    });
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
    if (
      balanceFrom.gt(
        parseUnits("" + getAssetAmount(limitUsd, priceUsd), fromAssetDecimals)
      )
    ) {
      await this.swapTo(fromAssetContract, toAssetContract, balanceFrom);
    }
  }

  async swapTo(
    fromAssetContract: ethers.Contract,
    toAssetContract: ethers.Contract,
    amountFrom: BigNumber
  ) {
    const router = new AlphaRouter({
      chainId: 1,
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

      await this.getWallet().sendTransaction(transaction);
    } else {
      throw new Error("Failed to execute alpha router call");
    }
  }

  async repayLoan(amount: BigNumber) {
    // TODO:
  }

  async openNewLoan() {
    // TODO:
    // if there is new USDC, deposit
    // open a new loan and adjust to ratio
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

      await this.getWallet().sendTransaction(transaction);
    } else {
      throw new Error(
        "Failed to execute alpha router call, status: " +
          routeToRatioResponse.status
      );
    }
  }

  getPoolContract(): ethers.Contract {
    return this.poolContract;
  }

  getNonFungiblePositionManager(): ethers.Contract {
    return this.nonFungiblePositionManager;
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

  getStablecoinContract(): ethers.Contract {
    return this.stablecoinContract;
  }

  getStablecoinDecimals(): number {
    return this.stablecoinDecimals;
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
    return this.getWallet().getGasPrice();
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
