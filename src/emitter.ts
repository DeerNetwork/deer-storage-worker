import { TypedEmitter } from "tiny-typed-emitter";
import {Header} from "@polkadot/types/interfaces";

interface Events {
  "header": (head: Header) => void;
  "file:add": (cid: string) => void;
  "file:del": (cid: string) => void;
  "reported": () => void;
}

export class Emitter extends TypedEmitter<Events> {}

export default new Emitter();
