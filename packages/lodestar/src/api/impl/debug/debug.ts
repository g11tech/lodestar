import {IApiOptions} from "../../options";
import {IApiModules} from "../interface";
import {DebugBeaconApi} from "./beacon";
import {IDebugBeaconApi} from "./beacon/interface";
import {IDebugApi} from "./interface";

export class DebugApi implements IDebugApi {
  beacon: IDebugBeaconApi;

  constructor(opts: Partial<IApiOptions>, modules: Pick<IApiModules, "config" | "logger" | "chain" | "db">) {
    this.beacon = new DebugBeaconApi(opts, modules);
  }
}
