import { TypedEmitter } from "tiny-typed-emitter";
import { Header } from "@polkadot/types/interfaces";

export interface Events {
  header: (head: Header) => void;
  "file:add": (cid: string) => void;
  "file:del": (cid: string) => void;
  reported: () => void;
  fatal: (message: string) => void;
}

export type Emitter = TypedEmitter<Events>;

export interface Task {
  type: "addFile" | "delFile" | "report" | "commit";
  cid?: string;
}
