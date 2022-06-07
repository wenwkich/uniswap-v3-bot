# Uniswap v3 Bot

This is a bot that will attempt to auto rebalance in a daily basis, only supporting USDC-ETH pair

Basic description of this strategy:

1. use the stablecoin to open a short position on ethereum to hedge the downside risk
2. mint a uniswap v3 position to provide liquidity that will be the -3 to +3 range (for example your `RANGE_TICKS` is set to 3)
3. check every hour if the price is out of -2 or +2 tick range (for example your `REBALANCE_TICKS` is set to 2)
4. check every hour if the LTV ratio is over `MAX_LTV_RATIO`, if that's the case, exit part of the position and repay the loan
5. check every hour if the LTV ratio is under `MIN_LTV_RATIO`, if that's the case, add more loan and add the position
