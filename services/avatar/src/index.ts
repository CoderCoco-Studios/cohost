/**
 * avatar — drives whatever avatar app you run (2D or 3D) from bus events.
 * Pick the app with AVATAR_DRIVER in .env; map emotions in config/expressions.yaml.
 */
import { Bus } from "@cohost/bus";
import { configDir, createLogger, loadConfig, loadExpressions } from "@cohost/config";
import { runAvatar } from "./boot.js";
import { createDriver } from "./drivers/index.js";

const log = createLogger("avatar");

void runAvatar({
  log,
  setup: () => {
    const cfg = loadConfig();
    const bus = new Bus("avatar", log);
    const driver = createDriver(cfg.avatar);
    const exprCfg = loadExpressions()[cfg.avatar.driver] ?? { gestures: {} }; // @spec AVATAR-DRV-005
    const { gestures, ...expressions } = exprCfg;
    return { cfg, bus, driver, expressions, gestures, stateDir: configDir() };
  },
});
