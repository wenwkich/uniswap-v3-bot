import { BigNumber } from "ethers";

type Network = "ethereum" | "polygon";
type Sentiment = "bearish" | "bullish";

export interface BotServiceOptions {
  // the address of the pool
  POOL_ADDRESS: string;
  // the network that is being used
  NETWORK: Network;
  // the tick range of the range provided
  RANGE_TICKS: number;
  // the tick range of rebalance trigger
  REBALANCE_TICKS: number;
  // max gas price, if target is hit, then set no gas price
  MAX_GAS_PRICE_GWEI: number;
  // will borrow more ETH if the price of ETH is down, hedging only
  MIN_LTV_RATIO: number;
  // will rebalance down if the max LTV is hit, hedging only
  MAX_LTV_RATIO: number;
  // avoid too frequent rebalance
  MIN_REBALANCE_HOUR: number;
  // base token is token0 or token1
  BASE_TOKEN: 0 | 1;
  // base token name, used to look up address or coingecko id
  BASE_TOKEN_NAME: string;
  // quote token name, used to look up address or coingecko id
  QUOTE_TOKEN_NAME: string;
  // number of sec to wait before check price in the next step
  PRICE_CHECK_INTERVAL_SEC: number;
  // accumulate fee of target asset collected to base to repay the loan
  ACCUMULATE_QUOTE_FEE_USD: number;
  // accumulate profit collect to USD
  ACCUMULATE_BASE_PROFIT_TO_USD: number;
  // collateral token name in the lending pool
  COLLATERAL_TOKEN: "quote" | "base" | "stable";
  // lending token name in the lending pool
  LENDING_TOKEN: "quote" | "base" | "stable";
  // transaction timeout in seconds
  TRANSACTION_TIMEOUT_SEC: number;
}
