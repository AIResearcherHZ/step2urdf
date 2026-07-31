import * as THREE from "three";

export type RendererType = "webgpu" | "webgl";

export type UniversalRenderer = THREE.WebGLRenderer | any;

export interface RendererConfig {
  antialias?: boolean;
  alpha?: boolean;
  preserveDrawingBuffer?: boolean;
  canvas?: HTMLCanvasElement;
}

export interface RendererResult {
  renderer: UniversalRenderer;
  type: RendererType;
}

export async function isWebGPUAvailable(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  if (!("gpu" in navigator)) return false;

  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;

    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;

    const device = await adapter.requestDevice();
    if (!device) return false;

    device.destroy();
    return true;
  } catch {
    return false;
  }
}

async function createWebGPURenderer(config: RendererConfig): Promise<UniversalRenderer | null> {
  try {
    const webgpuModule = await import("three/webgpu");
    const WebGPURenderer = webgpuModule.WebGPURenderer;

    const renderer = new WebGPURenderer({
      antialias: config.antialias !== false,
      alpha: config.alpha,
      canvas: config.canvas,
    });

    await renderer.init();

    console.log("✓ WebGPU 渲染器初始化成功");
    return renderer;
  } catch (error) {
    console.warn("WebGPU 渲染器创建失败，将降级到 WebGL:", error);
    return null;
  }
}

function createWebGLRenderer(config: RendererConfig): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: config.antialias !== false,
    alpha: config.alpha ?? true,
    preserveDrawingBuffer: config.preserveDrawingBuffer ?? true,
    canvas: config.canvas,
  });

  console.log("✓ WebGL 渲染器初始化成功");
  return renderer;
}

export async function createRenderer(
  config: RendererConfig = {},
  preferWebGPU = true,
): Promise<RendererResult> {
  if (preferWebGPU) {
    const gpuAvailable = await isWebGPUAvailable();

    if (gpuAvailable) {
      const webgpuRenderer = await createWebGPURenderer(config);
      if (webgpuRenderer) {
        return { renderer: webgpuRenderer, type: "webgpu" };
      }
    }
  }

  const webglRenderer = createWebGLRenderer(config);
  return { renderer: webglRenderer, type: "webgl" };
}

export function isWebGPURenderer(renderer: UniversalRenderer): boolean {
  return renderer && !("extensions" in renderer);
}

export function configureRenderer(
  renderer: UniversalRenderer,
  type: RendererType,
  options: {
    width: number;
    height: number;
    pixelRatio?: number;
    shadowMapEnabled?: boolean;
    toneMapping?: THREE.ToneMapping;
    toneMappingExposure?: number;
    outputColorSpace?: THREE.ColorSpace;
  },
): void {
  renderer.setSize(options.width, options.height);
  renderer.setPixelRatio(Math.min(options.pixelRatio ?? window.devicePixelRatio, 2));
  renderer.outputColorSpace = options.outputColorSpace ?? THREE.SRGBColorSpace;
  renderer.toneMapping = options.toneMapping ?? THREE.NoToneMapping;
  renderer.toneMappingExposure = options.toneMappingExposure ?? 1.0;

  if (type === "webgl") {
    const glRenderer = renderer as THREE.WebGLRenderer;
    glRenderer.shadowMap.enabled = options.shadowMapEnabled ?? true;
    glRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  } else {
    if (options.shadowMapEnabled !== false && renderer.shadowMap) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.VSMShadowMap;
    }
  }
}

export function takeScreenshot(
  renderer: UniversalRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): string {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL("image/png");
}
