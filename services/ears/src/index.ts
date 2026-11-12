/**
 * ears — the co-host's hearing. It turns audio into `speech.heard`: each enabled source (a connector's `audio.in.<tag>`
 * stream, `http` clips, `dir` files) hands utterances to one Hearing path, which transcribes them with the STT container
 * (speaches / faster-whisper, OpenAI-compatible) and publishes the speaker, so the brain knows who said what. It also
 * transcribes uploaded audio on `inject.request`. ears never speaks (her voice is the `mouth` service) and holds no Discord
 * client: the Discord connector holds the one bot login and serves the source `discord`.
 */
import { runService } from "@cohost/shared";
import { createEarsService } from "./service.js";

// @spec EARS-START-008
await runService({ service: "ears", ...createEarsService() });
