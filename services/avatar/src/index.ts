/**
 * avatar — drives whatever avatar app you run (2D or 3D) from bus events.
 * Pick the app with `avatar.driver` in config.yaml; map emotions in config/expressions.yaml.
 */
import { runAvatar } from "./boot.js";

void runAvatar(); // the shared bootstrap handles failures: it logs and exits 1
