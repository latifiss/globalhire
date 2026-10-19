import pino from "pino";
import { config } from "./env.js";

export const logger = pino({
  level: config.logLevel,
  base: { application: "globalhire" },
  timestamp: pino.stdTimeFunctions.isoTime
});
