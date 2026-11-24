// The thin WebGL layer of the renderer page: the canvas, the scene, the VRM load and the per-frame pose and framing. It is
// the part no UI test reaches (no GPU in the test runner): everything it decides comes from the pure modules beside it.
import { AmbientLight, Box3, DirectionalLight, Group, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { armRestQuaternion, expressionWrites, gazeAngles, headQuaternion, type LookAtRanges, type VrmVersion } from "./pose";
import type { Box, FramePlan } from "./framing";
import { isLoaderUrlAllowed } from "./loader-url";
import type { Frame } from "./frame";

export interface Stage {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** Holds the model: moved to the framing's pivot plus offset and turned by `turn`. */
  pivot: Group;
  fit(size: { width: number; height: number; pixelRatio: number }): void;
  render(): void;
}

/** A loaded model with what the pose needs from it. */
export interface LoadedModel {
  vrm: VRM;
  version: VrmVersion;
  box: Box;
  lookAt: LookAtRanges | null;
  /** The expression the last frame wrote, so the next frame can return it to 0 (DASH-AVP-010). */
  lastExpression: string;
}

/** The canvas and the scene: a transparent, alpha-cleared WebGL context (DASH-AVP-006) and lights. */
export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  scene.add(new AmbientLight(0xffffff, 1));
  const sun = new DirectionalLight(0xffffff, 1);
  sun.position.set(0, 1, 1);
  scene.add(sun);
  const camera = new PerspectiveCamera(30, 1, 0.01, 100);
  const pivot = new Group();
  scene.add(pivot);
  return {
    renderer,
    scene,
    camera,
    pivot,
    fit(size) {
      if (renderer.getPixelRatio() !== size.pixelRatio) renderer.setPixelRatio(size.pixelRatio);
      renderer.setSize(size.width, size.height, false);
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();
    },
    render() { renderer.render(scene, camera); },
  };
}

/**
 * Parses the fetched bytes as a glTF with the VRM plugin. Every URL the loader would request must be a `data:` or `blob:`
 * one (DASH-AVP-008), so a model that points elsewhere fails rather than fetching.
 */
// @spec DASH-AVP-008
export async function loadVrm(stage: Stage, bytes: ArrayBuffer, signal: AbortSignal): Promise<LoadedModel> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.manager.setURLModifier((url) => {
    if (!isLoaderUrlAllowed(url)) throw new Error("the model refers to a file that is not embedded");
    return url;
  });
  const gltf: GLTF = await loader.parseAsync(bytes, "");
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (vrm === undefined) throw new Error("the file holds no VRM model");
  const version: VrmVersion = vrm.meta.metaVersion === "0" ? "0.x" : "1.0";
  if (version === "0.x") VRMUtils.rotateVRM0(vrm);
  // The model's own overrides go: mouth, blink and look-at follow the frame, whatever the model's author set (DASH-AVP-017).
  for (const e of vrm.expressionManager?.expressions ?? []) {
    e.overrideBlink = "none";
    e.overrideMouth = "none";
    e.overrideLookAt = "none";
  }
  // No automatic look-at target (DASH-AVP-016).
  if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
  const left = vrm.humanoid?.getNormalizedBoneNode("leftUpperArm");
  const right = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
  left?.quaternion.set(...armRestQuaternion("left", version));
  right?.quaternion.set(...armRestQuaternion("right", version));
  vrm.scene.updateMatrixWorld(true);
  const b = new Box3().setFromObject(vrm.scene);
  const box: Box = { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
  stage.pivot.add(vrm.scene);
  return { vrm, version, box, lookAt: lookAtRanges(vrm), lastExpression: "" };
}

/** The look-at range maps' input limits, when the model has a look-at (DASH-AVP-016). */
function lookAtRanges(vrm: VRM): LookAtRanges | null {
  const applier = vrm.lookAt?.applier as unknown as Partial<Record<"rangeMapHorizontalOuter" | "rangeMapVerticalUp" | "rangeMapVerticalDown", { inputMaxValue: number }>> | undefined;
  if (!applier?.rangeMapHorizontalOuter || !applier.rangeMapVerticalUp || !applier.rangeMapVerticalDown) return null;
  return {
    horizontalOuter: applier.rangeMapHorizontalOuter.inputMaxValue,
    verticalUp: applier.rangeMapVerticalUp.inputMaxValue,
    verticalDown: applier.rangeMapVerticalDown.inputMaxValue,
  };
}

/** Removes a model from the scene and releases its geometry, textures and materials (DASH-AVP-025). */
export function disposeVrm(stage: Stage, model: LoadedModel): void {
  stage.pivot.remove(model.vrm.scene);
  VRMUtils.deepDispose(model.vrm.scene);
}

/** Places the model for a framing: the camera, the pivot and the turn of the plan (DASH-AVP-021). */
export function applyFraming(stage: Stage, plan: FramePlan): void {
  stage.camera.position.set(...plan.camera);
  stage.camera.lookAt(...plan.target);
  stage.pivot.position.set(plan.pivot[0], plan.pivot[1] + plan.modelOffsetY, plan.pivot[2]);
  stage.pivot.rotation.y = plan.modelRotationY;
}

/** Writes a frame to the model's expressions, head and gaze (DASH-AVP-010 to DASH-AVP-016); arms and framing are set elsewhere. */
export function applyPose(model: LoadedModel, pose: Frame): void {
  for (const w of expressionWrites(model.lastExpression, pose)) {
    const expression = model.vrm.expressionManager?.getExpression(w.name);
    if (expression) expression.weight = w.weight;
  }
  model.lastExpression = pose.expression;
  const head = model.vrm.humanoid?.getNormalizedBoneNode("head");
  if (head) head.quaternion.set(...headQuaternion(pose, model.version));
  const gaze = gazeAngles(pose, model.lookAt);
  if (gaze !== null) model.vrm.lookAt?.applier.applyYawPitch(gaze.yaw, gaze.pitch);
}
