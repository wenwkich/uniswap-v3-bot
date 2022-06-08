import { Service } from "typedi";
import winston, { format } from "winston";
const { splat, combine, timestamp, label, printf } = format;
@Service()
export class LoggerService {
  logger = winston.createLogger({
    format: combine(
      timestamp(),
      printf(({ level, message, timestamp }) => {
        return `${timestamp} ${level}: ${message}`;
      })
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: "combined.log" }),
    ],
  });

  getLogger() {
    return this.logger;
  }
}
