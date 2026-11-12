/**
 * mouth — the co-host's speaking module.
 *
 * Plays every `voice.utterance` on the outputs configured under `mouth.outputs` (the `discord` sink, served by the Discord
 * connector over the bus; the `file` and `http` archive outputs; the test-only `dryrun` output) and reports
 * `voice.playing` / `voice.done` with the output's name as the sink, so the avatar lip-syncs and the brain waits. When a line
 * cannot play it says a short pre-generated fallback line. mouth holds no Discord client and reads no token: the Discord
 * connector holds the one bot login and the one voice connection.
 */
import { runService } from "@cohost/shared";
import { createMouth, type MouthBus } from "./mouth.js";

// @spec MOUTH-START-006
const mouth = createMouth();
void runService<MouthBus>({ service: "mouth", health: mouth.health, main: mouth.main });
