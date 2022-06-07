import "dotenv/config";

export const PROVIDER_URLS = {
  ethereum: {
    url: process.env.ETHEREUM_PROVIDER_URL,
    chainId: 1,
  },
  polygon: {
    url: process.env.POLYGON_PROVIDER_URL,
    chainId: 137,
  },
};
