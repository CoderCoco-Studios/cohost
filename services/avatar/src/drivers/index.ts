import type { Config } from "@cohost/config";
import type { AvatarDriver } from "../types.js";
import { NullDriver } from "./null.js";
import { VTubeStudioDriver } from "./vtube-studio.js";
import { VmcDriver } from "./vmc.js";

/**
 * Driver registry. To add an app: implement AvatarDriver, add a case here,
 * add its name to the `avatar.driver` enum in packages/config/src/schema.ts,
 * and add a block to config/expressions.yaml.
 */
export function createDriver(cfg: Config["avatar"]): AvatarDriver {
  switch (cfg.driver) {
    case "vtube-studio":
      return new VTubeStudioDriver({
        host: cfg.vtube_studio.host,
        port: cfg.vtube_studio.port,
        pluginName: cfg.vtube_studio.plugin_name,
        pluginDeveloper: cfg.vtube_studio.plugin_developer,
      });
    case "vmc":
      return new VmcDriver({ host: cfg.vmc.host, port: cfg.vmc.port });
    case "null":
    default:
      return new NullDriver();
  }
}
