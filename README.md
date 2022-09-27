# Uniswap v3 AMM LP Bot (Automatic Market Maker)

This is a bot that will auto rebalance on a configurable manner, only supporting USDC-ETH pair at the moment (or other stable pair)

## Result

**This bot doesn't work because it's hard to assure atomicity, which some of steps should be aggregated inside a smart contract**

## Risk

The risk for this bot is that it is tested in production, the profitability has not been thoroughly tested

Also, right now the bot is only tested with `token0` as the "base" token, please be aware of the risk of using this bot

## Prerequisites

This bot also doesn't approve the tokens for you, it assumes that all the tokens has been approved

You need to approve:

- USDC & WETH to SwapRouter02
- USDC & WETH to AavePool

## Basic description of this strategy

1. use the stablecoin to open a short position on ethereum to hedge the downside risk
2. mint a uniswap v3 position to provide liquidity that will be the -2 to +2 tick range (for example your `RANGE_TICKS` is set to 2)
3. check every time if the LTV ratio is over `MAX_LTV_RATIO`, if that's the case, the bot will try to repay the loan
4. check every time if the LTV ratio is under `MIN_LTV_RATIO`, if that's the case, the bot will add more liquidity

if you want to change the config, please change `src/config.json` and refer to the comment of `src/common/interfaces.ts`

## How to run

1. Build the project by `yarn build`
2. Run the script by `PRIVATE_KEY=... node lib/index.js`

or

1. Install `ts-node` by `npm i -g ts-node`
2. Run the script by `PRIVATE_KEY=... ts-node src/index.js`

## Next step

- Dockerize the project
