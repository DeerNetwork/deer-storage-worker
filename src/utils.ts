import {createLogger, format, transports} from "winston";
import * as path from "path";
import config from "./config";

export const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss",
    }),
    format.colorize(),
    format.errors({stack: true}),
    format.printf(info => `[${info.timestamp}] ${info.level}: ${info.message}`)
  ),
  transports: [
    ...(config.log.console ? [new transports.Console()] : []),
    new transports.File({filename: path.resolve(config.log.dir, "host-error.log"), level: "error"}),
    new transports.File({filename: path.resolve(config.log.dir, "host.log") }),
  ],
});


export async function sleep(timeMs: number) {
  return new Promise(resolve => {
    setTimeout(resolve, timeMs);
  });
}
