import { BigNumber, ethers, utils } from "ethers";

const { parseUnits } = utils;

export function toBN(obj: number) {
  return BigNumber.from(obj);
}

export function parseGwei(obj: number) {
  return parseUnits("" + obj, "gwei");
}

export const sleep = (time: number) => {
  return new Promise((resolve) => setTimeout(resolve, Math.ceil(time * 1000)));
};

export const address = (entity: any) =>
  entity.address ?? ethers.constants.AddressZero;

export const balanceOf = async (tokenContract: ethers.Contract, entity: any) =>
  await tokenContract.balanceOf(address(entity));

export const getAssetAmount = (amountUsd: number, priceInUsd: number) => {
  return amountUsd / priceInUsd;
};

export const MAX_UINT128 = BigNumber.from(2).pow(128).sub(1);
