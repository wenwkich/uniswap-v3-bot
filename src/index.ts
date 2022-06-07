import "reflect-metadata";
import Container from "typedi";
import { EthStablePairBotService } from "./bot";
import { BotServiceOptions } from "./common/interfaces";
import OPTIONS from "./config.json";

const initLogger = () => {};

async function main(): Promise<void> {
  const bot = Container.get(EthStablePairBotService);
  await bot.setup(OPTIONS as BotServiceOptions);
  await bot.start();
}

if (require.main === module) {
  main();
}
