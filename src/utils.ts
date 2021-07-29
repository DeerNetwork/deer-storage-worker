import {createLogger, format, transports} from "winston";
import config from "./config";

export const logger = createLogger({
  level: config.log_level,
  format: format.combine(
    format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss",
    }),
    format.colorize(),
    format.errors({stack: true}),
    format.printf(info => `[${info.timestamp}] ${info.level}: ${info.message}`)
  ),
  transports: [
    new transports.Console(),
  ],
});

export async function sleep(timeMs: number) {
  return new Promise(resolve => {
    setTimeout(resolve, timeMs);
  });
}

export function hex2str(hex: string) {
  return Buffer.from(hex.substring(2), "hex").toString();
}

export function fatal(msg: string) {
  logger.error(`💥 Fatal error: ${msg}`);
  setTimeout(() => {
    process.exit();
  }, 0);
}
