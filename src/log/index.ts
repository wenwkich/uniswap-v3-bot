import { Service } from "typedi";
import winston from "winston";

@Service()
export class LoggerService {
  logger = winston.createLogger({
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: "combined.log" }),
    ],
  });

  getLogger() {
    return this.logger;
  }
}
