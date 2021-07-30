import {createLogger, format, transports} from "winston";
import config from "./config";

export const logger = createLogger({
  level: config.logLevel,
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

export function formatHexArr(arr: number[]) {
  return "0x" + Buffer.from(arr).toString("hex");
}

export function fatal(msg: string) {
  logger.error(`💥 Fatal ${msg}`);
  process.exit();
}
