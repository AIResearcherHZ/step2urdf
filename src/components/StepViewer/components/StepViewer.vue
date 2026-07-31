<template>
  <div class="step-viewer" ref="viewerRef">
    <Toolbar
      :file-name="store.currentFileName"
      :is-loading="store.isLoading"
      :has-model="store.hasModel"
      :has-selection="hasAnySelection"
      :show-axes="store.showAxes"
      :show-grid="store.showGrid"
      :show-stats="showStats"
      :occt-ready="occtReady"
      :occt-load-progress="occtLoadProgress"
      :is-line-measure-active="store.isLineMeasureActive"
      :opacity="opacityPercent"
      :is-model-tree-open="modelTreeVisible"
      :project-saving="persistence.saving.value"
      :autosave-hint="autosaveHint"
      @open-projects="handleOpenProjects"
      @save-project="handleSaveProject"
      @upload="handleFileUpload"
      @fit-view="handleFitView"
      @toggle-axes="handleToggleAxes"
      @toggle-grid="handleToggleGrid"
      @opacity-change="handleOpacityChange"
      @clear-selection="handleClearSelection"
      @reset-view="handleResetView"
      @toggle-stats="handleToggleStats"
      @toggle-line-measure="handleToggleLineMeasure"
      @toggle-model-tree="modelTreeVisible = !modelTreeVisible"
    />

    <div class="viewer-content">
      <URDFLeftPanel
        v-if="store.hasModel"
        ref="urdfLeftPanelRef"
        @export-urdf="handleExportURDF"
        @rotate-to-z-up="handleRotateToZUp"
        @reset-orientation="handleResetOrientation"
      />

      <SidePanel
        :visible="modelTreeVisible"
        @tree-select="handleTreeSelect"
        @solid-hover="handleSolidHover"
        @toggle-solid-visibility="handleToggleSolidVisibility"
        @close="modelTreeVisible = false"
      />

      <MeasurementPanel
        :visible="measurePanelVisible"
        @remove="handleRemoveMeasurement"
        @clear-all="handleClearMeasurements"
        @close="measurePanelVisible = false"
      />

      <div class="canvas-container" ref="canvasContainerRef">
        <StatsPanel
          :visible="showStats"
          :triangles="modelTriangles"
          :vertices="modelVertices"
          :draw-calls="frameDrawCalls"
          ref="statsPanelRef"
        />

        <LoadingOverlay
          :visible="store.isLoading"
          :progress="store.uploadProgress.progress"
          :message="store.uploadProgress.message"
          :status="store.uploadProgress.status"
          :file-name="store.currentFileName"
        />

        <div class="binding-overlay" v-if="urdfStore.bindingMode.active">
          <el-tag type="warning" effect="dark">
            点击 3D 场景中的 Solid 绑定到 Link
            <el-button size="small" text style="color: #fff" @click="urdfStore.stopBindingMode()"
              >完成</el-button
            >
          </el-tag>
        </div>

        <div class="binding-overlay" v-if="urdfStore.exporting">
          <el-tag type="info" effect="dark">
            {{ urdfStore.exportProgress || "正在导出..." }}
          </el-tag>
        </div>
      </div>

      <URDFRightPanel v-if="store.hasModel" @toggle-f-k-panel="handleToggleFKPanel" />
    </div>

    <FloatingJointControl :visible="fkPanelVisible" @close="fkPanelVisible = false" />

    <ProjectManager
      :visible="projectManagerVisible"
      :projects="persistence.projects.value"
      :current-id="persistence.context.value?.id ?? null"
      :busy="persistence.busy.value"
      :available="persistence.available.value"
      :has-current="store.hasModel && !!persistence.context.value"
      :storage-text="storageText"
      @close="projectManagerVisible = false"
      @open="handleOpenProject"
      @remove="handleRemoveProject"
      @rename="handleRenameProject"
      @import="handleImportProject"
      @export="handleExportProject"
    />

    <JointWizard
      ref="jointWizardRef"
      @created="urdfScene.handleJointCreated"
      @start-edge-pick="urdfScene.startEdgePickMode"
      @stop-edge-pick="urdfScene.stopEdgePickMode"
      @flip-axis="urdfScene.flipAxis"
      @preview-axis="urdfScene.previewAxisCandidate"
      @show-gizmo="urdfScene.showAxisGizmo"
      @cycle-candidate="urdfScene.cycleAxisCandidate"
      @toggle-xray="urdfScene.setXray"
    />

    <div class="status-bar">
      <template v-if="store.hasModel">
        <span class="status-item"
          >实体: <b>{{ store.solids.length }}</b></span
        >
        <span class="status-sep">|</span>
        <span class="status-item"
          >URDF: <b>{{ urdfStore.robot.name }}</b></span
        >
        <span class="status-sep">|</span>
        <span class="status-item"
          >Links: <b>{{ urdfStore.robot.links.length }}</b></span
        >
        <span class="status-sep">|</span>
        <span class="status-item"
          >Joints: <b>{{ urdfStore.robot.joints.length }}</b></span
        >
        <template v-if="store.selectedSolidNames.length">
          <span class="status-sep">|</span>
          <span class="status-item status-selected">{{ store.selectedSolidNames.join(", ") }}</span>
        </template>
      </template>
      <span v-else class="status-item">{{
        occtReady ? "就绪 — 支持 .step / .stp 文件" : "正在加载 OpenCASCADE..."
      }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import * as THREE from "three";
import Toolbar from "./Toolbar.vue";
import SidePanel from "./SidePanel.vue";
import MeasurementPanel from "./MeasurementPanel.vue";
import StatsPanel from "./StatsPanel.vue";
import LoadingOverlay from "./LoadingOverlay.vue";
import URDFLeftPanel from "./URDFBuilder/URDFLeftPanel.vue";
import URDFRightPanel from "./URDFBuilder/URDFRightPanel.vue";
import FloatingJointControl from "./URDFBuilder/FloatingJointControl.vue";
import JointWizard from "./URDFBuilder/JointWizard.vue";
import ProjectManager from "./ProjectManager.vue";
import { useProjectPersistence } from "../persistence/useProjectPersistence";
import { estimateStorage } from "../persistence/opfs";
import { ProjectFormatError } from "../persistence/types";
import { useStepViewerStore } from "../stores/useStepViewerStore";
import { useURDFStore } from "../stores/useURDFStore";
import { StepLoader, SceneManager, SelectionManager, preloadOcct, isOcctLoaded } from "../core";
import { LineMeasurementTool } from "../core/LineMeasurementTool";
import { disposeKinematicsWorker } from "../core/useKinematicsWorker";
import {
  upAxisToZUpMatrix,
  isIdentityRotation,
  rotateSerializedSolid,
  rotateInertialParams,
  rotateTuple3,
  rotateRPY,
  type UpAxis,
} from "../core/ZUpTransform";
import { useURDFScene } from "./composables/useURDFScene";
import type {
  TreeNode,
  SerializedSolidData,
  SerializedTreeNode,
  CameraConfig,
} from "../types";
import { FeatureType, ViewPreset } from "../types";

const props = withDefaults(
  defineProps<{
    width?: string | number;
    height?: string | number;
    backgroundColor?: number;
    showStatsPanel?: boolean;
  }>(),
  {
    width: "100%",
    height: "100%",
    backgroundColor: 0xf5f5f5,
    showStatsPanel: false,
  },
);

const store = useStepViewerStore();
const urdfStore = useURDFStore();

const viewerRef = ref<HTMLElement>();
const canvasContainerRef = ref<HTMLElement>();
const statsPanelRef = ref<InstanceType<typeof StatsPanel>>();

const showStats = ref(props.showStatsPanel);

const modelTriangles = ref(0);
const modelVertices = ref(0);
const frameDrawCalls = ref(0);

const occtReady = ref(isOcctLoaded());
const occtLoadProgress = ref(isOcctLoaded() ? 100 : 0);

const fkPanelVisible = ref(false);
function handleToggleFKPanel(): void {
  fkPanelVisible.value = !fkPanelVisible.value;
}

const modelTreeVisible = ref(false);
const measurePanelVisible = ref(false);

const exportCompleteAdVisible = ref(false);

let stepLoader: StepLoader | null = null;
let sceneManager: SceneManager | null = null;
let selectionManager: SelectionManager | null = null;
let lineMeasurementTool: LineMeasurementTool | null = null;

const urdfScene = useURDFScene({
  getSceneManager: () => sceneManager,
  getSelectionManager: () => selectionManager,
});

const projectManagerVisible = ref(false);
const storageText = ref("");

async function applyRestoredScene(
  solids: SerializedSolidData[],
  tree: SerializedTreeNode | null,
): Promise<void> {
  if (!stepLoader || !sceneManager) throw new Error("渲染器尚未就绪");

  const restored = stepLoader.restoreScene(solids, tree);
  sceneManager.addModel(restored.group);

  store.setSolids(restored.solids);
  store.setTreeNodes(restored.treeNodes);

  if (selectionManager) {
    selectionManager.setSolids(restored.solids);
    selectionManager.setOpacity(null, store.globalOpacity);
    store.setTransparent(store.globalOpacity < 1);
  }

  modelTriangles.value = sceneManager.sceneTriangles;
  modelVertices.value = sceneManager.sceneVertices;

  await nextTick();

  if (canvasContainerRef.value) {
    const { clientWidth, clientHeight } = canvasContainerRef.value;
    if (clientWidth > 0 && clientHeight > 0) {
      sceneManager.updateSize(clientWidth, clientHeight);
    }
  }

  initURDFModules();
  modelTreeVisible.value = true;
}

const persistence = useProjectPersistence({
  getCamera: () => sceneManager?.getCameraConfig() ?? null,
  setCamera: (config: Partial<CameraConfig>) => sceneManager?.setCameraConfig(config, false),
  captureThumbnail: async () => {
    if (!sceneManager) return null;
    try {
      sceneManager.renderFrame();
      const canvas = sceneManager.getDomElement();
      if (!canvas) return null;
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => resolve(blob), "image/png");
      });
    } catch {
      return null;
    }
  },
  parseStep: async (bytes, fileName) => {
    if (!stepLoader) throw new Error("解析器尚未就绪");
    store.setFileName(fileName);
    const copy = bytes.slice();
    const result = await stepLoader.parseBuffer(
      copy.buffer as ArrayBuffer,
      (progress) => store.updateUploadProgress(progress),
    );
    return { solids: result.solids, tree: result.tree };
  },
  rebuildScene: applyRestoredScene,
  clearWorkspace: () => handleClearAll(),
  onStatus: (message, percent) => {
    store.updateUploadProgress({
      status: percent >= 100 ? "success" : "parsing",
      progress: percent,
      message,
    });
  },
});

const autosaveHint = computed(() => {
  if (!persistence.available.value) return "浏览器不支持本地存储，仅可导出 .miles 文件";
  const ts = persistence.lastSavedAt.value;
  if (!ts) return "尚未自动保存";
  return `上次自动保存: ${new Date(ts).toLocaleTimeString()}`;
});

async function refreshStorageText(): Promise<void> {
  const estimate = await estimateStorage();
  if (!estimate) {
    storageText.value = "";
    return;
  }
  const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
  storageText.value = `已用 ${gb(estimate.usage)} GB / 可用 ${gb(estimate.available)} GB`;
}

async function handleOpenProjects(): Promise<void> {
  projectManagerVisible.value = true;
  await persistence.refreshList();
  await refreshStorageText();
}

async function handleSaveProject(): Promise<void> {
  if (!persistence.context.value) {
    ElMessage.warning("请先导入一个 STEP 模型");
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt("为该项目命名", "保存项目", {
      inputValue: persistence.context.value.name,
      inputValidator: (v: string) => (v.trim().length > 0 ? true : "名称不能为空"),
      confirmButtonText: "保存",
      cancelButtonText: "取消",
    });
    await persistence.saveProject(value.trim());
    ElMessage.success("项目已保存");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(`保存失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleOpenProject(id: string): Promise<void> {
  projectManagerVisible.value = false;
  try {
    await persistence.openProject(id);
    sceneManager?.fitToModel();
    ElMessage.success("项目已恢复");
  } catch (error) {
    store.updateUploadProgress({ status: "error", progress: 0, message: "项目加载失败" });
    ElMessage.error(`项目加载失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleRemoveProject(id: string): Promise<void> {
  await persistence.removeProject(id);
  await refreshStorageText();
  ElMessage.success("项目已删除");
}

async function handleRenameProject(id: string, name: string): Promise<void> {
  await persistence.renameProject(id, name);
  ElMessage.success("已重命名");
}

async function handleImportProject(file: File): Promise<void> {
  projectManagerVisible.value = false;
  try {
    await persistence.importProjectFile(file);
    sceneManager?.fitToModel();
    ElMessage.success("项目文件已导入");
  } catch (error) {
    store.updateUploadProgress({ status: "error", progress: 0, message: "导入失败" });
    if (error instanceof ProjectFormatError) {
      ElMessage.error(error.message);
    } else {
      ElMessage.error(`导入失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function handleExportProject(): Promise<void> {
  try {
    const saved = await persistence.exportProjectFile();
    if (saved) ElMessage.success("项目文件已导出");
  } catch (error) {
    ElMessage.error(`导出失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function promptDraftRecovery(): Promise<void> {
  const draft = await persistence.detectDraft();
  if (!draft) return;

  try {
    await ElMessageBox.confirm(
      `检测到未保存的会话「${draft.name}」（${draft.sourceFileName}，${new Date(draft.updatedAt).toLocaleString()}），是否恢复？`,
      "恢复上次会话",
      { confirmButtonText: "恢复", cancelButtonText: "丢弃", type: "info" },
    );
    await handleOpenProject(draft.id);
  } catch (action) {
    if (action === "cancel") {
      await persistence.discardDraft();
      ElMessage.info("已丢弃上次会话");
    }
  }
}

const jointWizardRef = ref<InstanceType<typeof JointWizard>>();
const urdfLeftPanelRef = ref<{ setCurrentNodeById: (id: string) => void } | null>(null);
let isHighlightingFromWatcher = false;

const hasAnySelection = computed(
  () =>
    store.selectedFeatures.length > 0 || !!urdfStore.selectedLinkId || !!urdfStore.selectedJointId,
);

const effectiveHighlightSolidIds = computed<string[]>(() => {
  if (urdfStore.bindingMode.active && urdfStore.bindingMode.targetLinkId) {
    const link = urdfStore.linkMap.get(urdfStore.bindingMode.targetLinkId);
    return link?.solidIds.slice() ?? [];
  }
  if (urdfStore.selectedLinkId) {
    const link = urdfStore.linkMap.get(urdfStore.selectedLinkId);
    return link?.solidIds.slice() ?? [];
  }
  if (urdfStore.selectedJointId) {
    const joint = urdfStore.jointMap.get(urdfStore.selectedJointId);
    if (joint) {
      const parentLink = urdfStore.linkMap.get(joint.parentLinkId);
      const childLink = urdfStore.linkMap.get(joint.childLinkId);
      return [...(parentLink?.solidIds ?? []), ...(childLink?.solidIds ?? [])];
    }
  }
  return [];
});

const opacityPercent = computed(() => {
  return Math.round(store.globalOpacity * 100);
});

onMounted(async () => {
  await nextTick();

  let progressTimer: ReturnType<typeof setInterval> | null = null;
  if (!occtReady.value) {
    occtLoadProgress.value = 5;
    progressTimer = setInterval(() => {
      if (occtLoadProgress.value < 90) {
        occtLoadProgress.value += Math.random() * 8 + 2;
        if (occtLoadProgress.value > 90) occtLoadProgress.value = 90;
      }
    }, 600);
  }
  preloadOcct()
    .then(() => {
      if (progressTimer) clearInterval(progressTimer);
      occtLoadProgress.value = 100;
      occtReady.value = true;
      console.log("OpenCASCADE WASM 预加载完成");
      void persistence.refreshList().then(() => promptDraftRecovery());
    })
    .catch((err) => {
      if (progressTimer) clearInterval(progressTimer);
      occtLoadProgress.value = 0;
      console.error("OpenCASCADE 预加载失败:", err);
    });

  await initViewer();

  window.addEventListener("keydown", handleViewShortcut);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleViewShortcut);
  disposeViewer();
});

async function initViewer(): Promise<void> {
  if (!canvasContainerRef.value) return;

  stepLoader = new StepLoader();

  sceneManager = new SceneManager({
    container: canvasContainerRef.value,
    backgroundColor: props.backgroundColor,
    showAxes: store.showAxes,
    showGrid: store.showGrid,
  });

  await sceneManager.waitForReady();

  selectionManager = new SelectionManager({
    camera: sceneManager.camera,
    scene: sceneManager.scene,
    domElement: sceneManager.getDomElement(),
    controls: sceneManager.controls,
    onRenderRequest: () => sceneManager?.requestRender(),
  });

  selectionManager.onSelect((event) => {
    if (isHighlightingFromWatcher) return;

    const features = event.selections.map((s) => s.feature);

    if (urdfStore.bindingMode.active && features.length > 0) {
      urdfScene.handleBindingClick(features[0]);
      return;
    }

    if (urdfScene.isEdgePickMode() && features.length > 0) {
      const f = features[0];
      const isAxisFace =
        f.type === FeatureType.CYLINDER ||
        f.type === FeatureType.CONE ||
        f.type === FeatureType.ARC ||
        f.type === FeatureType.TORUS;
      const isAccepted =
        f.edgeCurveType === "circle" ||
        f.edgeCurveType === "arc" ||
        f.edgeCurveType === "line" ||
        isAxisFace;

      if (!isAccepted) {
        if (f.edgeCurveType === "bspline" || f.edgeCurveType === "bezier") {
          ElMessage.warning("不支持 B 样条/贝塞尔曲线，请选择圆弧边或直线");
        } else {
          ElMessage.warning("请选择圆弧边或直线作为旋转轴参考");
        }
        return;
      }

      if (urdfStore.edgePickEditJointId) {
        urdfScene.applyPickedEdgeToExistingJoint(urdfStore.edgePickEditJointId, f);
      } else {
        jointWizardRef.value?.applyPickedEdge(f);
      }
      return;
    }

    if (urdfStore.basePickMode && features.length > 0) {
      const f = features[0];
      let px = 0,
        py = 0,
        pz = 0;
      if (f.center) {
        px = f.center.x;
        py = f.center.y;
        pz = f.center.z;
      } else if (f.solidId) {
        const solid = store.solidMap.get(f.solidId);
        const pos = solid?.serializedData?.positions;
        if (pos && pos.length >= 3) {
          let sx = 0,
            sy = 0,
            sz = 0,
            n = 0;
          for (let i = 0; i < pos.length; i += 3) {
            sx += pos[i];
            sy += pos[i + 1];
            sz += pos[i + 2];
            n++;
          }
          if (n > 0) {
            px = sx / n;
            py = sy / n;
            pz = sz / n;
          }
        }
      }
      const round = (v: number) => Math.round(v * 10000) / 10000;
      urdfStore.baseLinkOrigin = [round(px), round(py), round(pz)];
      urdfStore.basePickMode = false;
      urdfScene.updateFKAndFrames();
      ElMessage.success("Base Origin 已设置");
      return;
    }

    store.setSelectedFeatures(features);

    if (
      !isHighlightingFromWatcher &&
      !urdfStore.bindingMode.active &&
      features.length > 0 &&
      features[0].solidId
    ) {
      const solidId = features[0].solidId;
      const ownerLink = urdfStore.robot.links.find((l) => l.solidIds.includes(solidId));
      if (ownerLink) {
        urdfStore.selectedLinkId = ownerLink.id;
        urdfStore.selectedJointId = null;
        nextTick(() => urdfLeftPanelRef.value?.setCurrentNodeById(ownerLink.id));
      }
    }

    if (event.selectedTreeNodeIds) {
      for (const id of event.selectedTreeNodeIds) {
        const edgeMatch = id.match(/^(solid_\d+)_edge_\d+$/);
        if (edgeMatch) {
          const parentSolidId = edgeMatch[1];
          if (!store.expandedTreeNodeIds.includes(parentSolidId)) {
            store.expandedTreeNodeIds.push(parentSolidId);
          }
        }
      }
      store.syncTreeFromSelection(event.selectedTreeNodeIds);
    }

    urdfScene.updateFKAndFrames();
    sceneManager?.markDirty();
  });

  selectionManager.onHover((feature) => {
    urdfScene.handleHoverSnap(feature);
  });

  selectionManager.onAxisCandidates((info) => {
    jointWizardRef.value?.setCandidateInfo(info);
  });

  sceneManager.addRenderCallback(() => {
    if (sceneManager) {
      frameDrawCalls.value = sceneManager.frameDrawCalls;
    }
  });

  const domElement = sceneManager.getDomElement();
  domElement.addEventListener("pointerup", handleViewHelperClick);

  lineMeasurementTool = new LineMeasurementTool({
    scene: sceneManager.scene,
    camera: sceneManager.camera,
    domElement: sceneManager.getDomElement(),
    container: canvasContainerRef.value,
    controls: sceneManager.controls,
    onRenderRequest: () => sceneManager?.requestRender(),
    onLineAdded: (line) => {
      store.addLineMeasurement(line);
      sceneManager?.markDirty();
    },
    onLineRemoved: (id) => {
      store.removeLineMeasurement(id);
      sceneManager?.markDirty();
    },
  });

  const resizeObserver = new ResizeObserver(() => {
    if (canvasContainerRef.value && sceneManager) {
      const { clientWidth, clientHeight } = canvasContainerRef.value;
      sceneManager.updateSize(clientWidth, clientHeight);
    }
  });
  resizeObserver.observe(canvasContainerRef.value);
}

function handleViewShortcut(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement)?.tagName;

  if (e.key === "Tab" && urdfScene.isEdgePickMode()) {
    e.preventDefault();
    urdfScene.cycleAxisCandidate(e.shiftKey ? -1 : 1);
    return;
  }

  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (!sceneManager) return;

  switch (e.key) {
    case "x":
      sceneManager.setViewPreset(ViewPreset.RIGHT);
      break;
    case "X":
      sceneManager.setViewPreset(ViewPreset.LEFT);
      break;
    case "y":
      sceneManager.setViewPreset(ViewPreset.TOP);
      break;
    case "Y":
      sceneManager.setViewPreset(ViewPreset.BOTTOM);
      break;
    case "z":
      sceneManager.setViewPreset(ViewPreset.FRONT);
      break;
    case "Z":
      sceneManager.setViewPreset(ViewPreset.BACK);
      break;
    case "f":
      sceneManager.setViewPreset(ViewPreset.ISOMETRIC);
      break;
    default:
      return;
  }
}

function disposeViewer(): void {
  if (lineMeasurementTool) {
    lineMeasurementTool.dispose();
    lineMeasurementTool = null;
  }

  if (sceneManager) {
    const domElement = sceneManager.getDomElement();
    domElement.removeEventListener("pointerup", handleViewHelperClick);
  }

  urdfScene.disposeModules();
  disposeKinematicsWorker();

  selectionManager?.dispose();
  sceneManager?.dispose();

  stepLoader = null;
  sceneManager = null;
  selectionManager = null;
}

function handleViewHelperClick(event: PointerEvent): void {
  if (sceneManager?.handleViewHelperClick(event)) {
    event.stopPropagation();
  }
}

async function handleFileUpload(file: File): Promise<void> {
  if (!stepLoader) return;

  if (!occtReady.value) {
    ElMessage.warning("OpenCASCADE 引擎正在加载，请稍候...");
    return;
  }

  const validation = stepLoader.validateFile(file);
  if (!validation.valid) {
    ElMessage.error(validation.error || "文件校验失败");
    return;
  }

  try {
    handleClearAll();
    store.setFileName(file.name);

    store.updateUploadProgress({
      status: "parsing",
      progress: 5,
      message: "准备加载...",
    });

    const {
      solids,
      group,
      treeNodes,
      tree: serializedTree,
    } = await stepLoader.loadFile(file, (progress) => {
      if (progress.status === "success") {
        store.updateUploadProgress({
          status: "parsing",
          progress: 90,
          message: "正在渲染模型...",
        });
      } else {
        store.updateUploadProgress(progress);
      }
    });

    if (sceneManager) {
      sceneManager.addModel(group);
      sceneManager.fitToModel();
    }

    store.setSolids(solids);
    store.setTreeNodes(treeNodes);

    if (selectionManager) {
      selectionManager.setSolids(solids);
      selectionManager.setOpacity(null, store.globalOpacity);
      store.setTransparent(store.globalOpacity < 1);
    }

    modelTriangles.value = sceneManager?.sceneTriangles ?? 0;
    modelVertices.value = sceneManager?.sceneVertices ?? 0;

    await nextTick();

    if (sceneManager && canvasContainerRef.value) {
      const { clientWidth, clientHeight } = canvasContainerRef.value;
      if (clientWidth > 0 && clientHeight > 0) {
        sceneManager.updateSize(clientWidth, clientHeight);
      }
      sceneManager.fitToModel();
    }

    store.updateUploadProgress({
      status: "success",
      progress: 100,
      message: "加载完成",
    });

    initURDFModules();
    modelTreeVisible.value = true;
    ElMessage.success("模型加载成功");

    void (async () => {
      try {
        const ctx = await persistence.beginProject(file);
        if (!ctx) return;
        const cached: SerializedSolidData[] = [];
        for (const solid of store.solids) {
          if (solid.serializedData) cached.push(solid.serializedData);
        }
        if (cached.length > 0) {
          await persistence.cacheGeometry(cached, serializedTree);
        }
        await persistence.flushSave();
        await persistence.saveThumbnail();
      } catch (error) {
        console.warn("项目自动保存初始化失败:", error);
      }
    })();
  } catch (error) {
    console.error("加载失败:", error);
    store.updateUploadProgress({
      status: "error",
      progress: 0,
      message: error instanceof Error ? error.message : "加载失败",
    });
    ElMessage.error(error instanceof Error ? error.message : "模型加载失败");
  }
}

function handleTreeSelect(node: TreeNode, multi: boolean): void {
  if (!selectionManager) return;

  if (node.type === "solid" && node.solidIndex !== undefined) {
    const solidId = `solid_${node.solidIndex}`;
    const solid = store.solidMap.get(solidId);
    if (solid) {
      selectionManager.selectBySolidId(solid.id, multi);
    }
  } else if (
    node.type === "edge" &&
    node.solidIndex !== undefined &&
    node.edgeIndex !== undefined
  ) {
    const solidId = `solid_${node.solidIndex}`;
    const solid = store.solidMap.get(solidId);
    if (solid) {
      selectionManager.selectByEdgeIndex(solid.id, node.edgeIndex, multi);
    }
  }

  sceneManager?.markDirty();
}

function handleFitView(): void {
  sceneManager?.fitToModel();
}

function handleToggleAxes(): void {
  const newValue = !store.showAxes;
  store.setShowAxes(newValue);
  sceneManager?.showAxes(newValue);
}

function handleToggleGrid(): void {
  const newValue = !store.showGrid;
  store.setShowGrid(newValue);
  sceneManager?.showGrid(newValue);
}

function handleOpacityChange(percent: number): void {
  const opacity = percent / 100;
  store.setGlobalOpacity(opacity);
  store.setTransparent(opacity < 1);
  urdfScene.syncOpacityBaseline(opacity);
  selectionManager?.setOpacity(null, opacity);
  sceneManager?.markDirty();
}

function handleToggleStats(): void {
  showStats.value = !showStats.value;
}

function handleClearSelection(): void {
  if (urdfStore.bindingMode.active) {
    ElMessage.warning("请先点击「 完成绑定」按钮，完成当前 Solid 绑定后再操作");
    return;
  }
  if (urdfStore.edgePickEditJointId) {
    ElMessage.warning("请先点击「✕ 停止拾取」结束关节轴线拾取后再操作");
    return;
  }
  selectionManager?.clearSelection();
  store.clearSelection();
  urdfStore.selectedLinkId = null;
  urdfStore.selectedJointId = null;
  nextTick(() => urdfLeftPanelRef.value?.setCurrentNodeById(""));
}

function handleResetView(): void {
  sceneManager?.fitToModel();
}

function handleToggleLineMeasure(): void {
  if (!lineMeasurementTool) return;
  const active = !store.isLineMeasureActive;
  store.setLineMeasureActive(active);
  if (active) {
    lineMeasurementTool.activate();
    measurePanelVisible.value = true;
    selectionManager?.setEnabled(false);
  } else {
    lineMeasurementTool.deactivate();
    measurePanelVisible.value = false;
    selectionManager?.setEnabled(true);
  }
  sceneManager?.markDirty();
}

function handleRemoveMeasurement(id: string): void {
  lineMeasurementTool?.removeLine(id);
  sceneManager?.markDirty();
}

function handleClearMeasurements(): void {
  lineMeasurementTool?.clearAll();
  store.clearLineMeasurements();
  sceneManager?.markDirty();
}

function handleClearAll(): void {
  handleClearSelection();
  if (lineMeasurementTool) {
    lineMeasurementTool.clearAll();
  }
  store.clearLineMeasurements();
  if (store.isLineMeasureActive) {
    store.setLineMeasureActive(false);
    lineMeasurementTool?.deactivate();
    selectionManager?.setEnabled(true);
  }

  urdfStore.clearAll();
  urdfScene.disposeModules();

  sceneManager?.clearModels();
  store.clearModel();
  modelTriangles.value = 0;
  modelVertices.value = 0;
  frameDrawCalls.value = 0;
}

function initURDFModules(): void {
  urdfScene.initModules();
}

function applyGlobalRotation(m: THREE.Matrix4): boolean {
  if (!stepLoader || !sceneManager) return false;

  const ordered: SerializedSolidData[] = [];
  for (const solid of store.solids) {
    if (!solid.serializedData) {
      ElMessage.warning("部分实体缺少几何数据，无法整机旋转");
      return false;
    }
    ordered.push(solid.serializedData);
  }
  if (ordered.length === 0) return false;

  const previousState = new Map(
    store.solids.map((s) => [s.id, { visible: s.visible, opacity: s.opacity }]),
  );

  for (const data of ordered) {
    rotateSerializedSolid(data, m);
  }

  const childLinkIds = new Set(urdfStore.robot.joints.map((j) => j.childLinkId));
  for (const joint of urdfStore.robot.joints) {
    if (childLinkIds.has(joint.parentLinkId)) continue;
    urdfStore.updateJoint(joint.id, {
      origin: {
        xyz: rotateTuple3(joint.origin.xyz, m, true),
        rpy: rotateRPY(joint.origin.rpy, m),
      },
      axisOffset: rotateTuple3(joint.axisOffset, m, false),
    });
  }

  for (const link of urdfStore.robot.links) {
    if (link.inertial) {
      link.inertial = rotateInertialParams(link.inertial, m);
    }
  }

  if (urdfStore.baseLinkOrigin) {
    urdfStore.baseLinkOrigin = rotateTuple3(urdfStore.baseLinkOrigin, m, true);
  }
  if (urdfStore.baseLinkRPY) {
    urdfStore.baseLinkRPY = rotateRPY(urdfStore.baseLinkRPY, m);
  }

  handleClearSelection();
  lineMeasurementTool?.clearAll();
  store.clearLineMeasurements();
  urdfStore.clearCollisionShapes();
  urdfScene.disposeModules();
  sceneManager.clearModels();

  const { solids, group } = stepLoader.rebuildFromSerialized(ordered);
  sceneManager.addModel(group);
  store.setSolids(solids);

  if (selectionManager) {
    selectionManager.setSolids(solids);
    for (const [solidId, state] of previousState) {
      if (!state.visible) selectionManager.setVisibility(solidId, false);
    }
    selectionManager.setOpacity(null, store.globalOpacity);
  }

  urdfScene.initModules();
  sceneManager.fitToModel();
  modelTriangles.value = sceneManager.sceneTriangles;
  modelVertices.value = sceneManager.sceneVertices;
  return true;
}

function handleRotateToZUp(up: UpAxis): void {
  if (!store.hasModel) {
    ElMessage.warning("请先加载模型");
    return;
  }

  const m = upAxisToZUpMatrix(up);
  if (isIdentityRotation(m)) {
    ElMessage.info("所选朝上轴已是 +Z，无需旋转");
    return;
  }

  const accumulated = new THREE.Matrix4().multiplyMatrices(m, store.getModelRotation());
  if (!applyGlobalRotation(m)) return;

  store.setModelRotation(accumulated);
  ElMessage.success(`已将 ${up} 旋转到 Z-up 右手坐标系`);
}

function handleResetOrientation(): void {
  if (!store.hasModel) {
    ElMessage.warning("请先加载模型");
    return;
  }

  const accumulated = store.getModelRotation();
  if (isIdentityRotation(accumulated)) {
    ElMessage.info("当前已是原始朝向");
    return;
  }

  if (!applyGlobalRotation(accumulated.clone().invert())) return;

  store.setModelRotation(new THREE.Matrix4());
  ElMessage.success("已恢复模型原始朝向");
}

async function handleExportURDF(): Promise<void> {
  await urdfScene.handleExportURDF(exportCompleteAdVisible);
}

watch(
  () => urdfStore.robot.joints,
  () => {
    urdfScene.updateFKAndFrames();
  },
  { deep: true },
);

watch(
  () => urdfStore.showFrames,
  (val) => {
    urdfScene.setFrameVisible(val);
    sceneManager?.markDirty();
  },
);

watch(
  () => urdfStore.collisionShapes,
  () => {
    urdfScene.refreshCollisionVisual();
  },
  { deep: true },
);

watch(
  () => urdfStore.collisionConfig.visible,
  (val) => {
    urdfScene.setCollisionVisible(val);
  },
);

watch(
  () => urdfStore.robot.links.length,
  () => {
    urdfScene.updateFKAndFrames();
  },
);

watch(
  () => urdfStore.edgePickEditJointId,
  (id) => {
    if (id && !urdfScene.isEdgePickMode()) {
      urdfScene.startEdgePickMode();
    } else if (!id && urdfScene.isEdgePickMode()) {
      urdfScene.stopEdgePickMode();
    }
  },
);

watch(
  () => urdfStore.axisHelperScale,
  (scale) => {
    urdfScene.setAxisLength(scale);
  },
);

watch(
  () => urdfStore.baseLinkOrigin,
  () => {
    urdfScene.updateFKAndFrames();
  },
  { deep: true },
);

watch(
  () => urdfStore.baseLinkRPY,
  () => {
    urdfScene.updateFKAndFrames();
  },
  { deep: true },
);

watch(effectiveHighlightSolidIds, (solidIds) => {
  if (!selectionManager) return;
  isHighlightingFromWatcher = true;
  try {
    selectionManager.clearSelection();
    solidIds.forEach((sid) => selectionManager!.selectBySolidId(sid, true));
  } finally {
    isHighlightingFromWatcher = false;
  }
  store.setSelectedFeatures(selectionManager.getSelectedFeatures());
  sceneManager?.markDirty();
});

function handleSolidHover(solidId: string | null): void {
  selectionManager?.hoverBySolidId(solidId);
  sceneManager?.markDirty();
}

function handleToggleSolidVisibility(solidId: string): void {
  store.toggleSolidVisibility(solidId);
  const visible = store.isSolidVisible(solidId);
  selectionManager?.setVisibility(solidId, visible);
  sceneManager?.markDirty();
}

watch(
  () => store.solidVisibilityMap.size,
  () => {
    for (const solid of store.solids) {
      const visible = store.isSolidVisible(solid.id);
      if (solid.mesh) {
        solid.mesh.visible = visible;
      }
    }
    sceneManager?.markDirty();
  },
);

defineExpose({
  fitView: handleFitView,
  clearSelection: handleClearSelection,
  loadFile: handleFileUpload,
});
</script>

<style lang="scss" scoped>
.step-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #fff;
  overflow: hidden;
}

.viewer-content {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.canvas-container {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: #f5f5f5;

  :deep(canvas) {
    display: block;
  }
}

.empty-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(245, 245, 245, 0.95);
  z-index: 10;
}

.binding-overlay {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
}

.empty-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.empty-text {
  color: #909399;
  font-size: 14px;
  margin: 0;
}

.status-bar {
  display: flex;
  align-items: center;
  padding: 3px 12px;
  font-size: 12px;
  color: #606266;
  background: #f5f5f5;
  border-top: 1px solid #e4e7ed;
  white-space: nowrap;
  overflow: hidden;
  gap: 0;

  .status-item {
    flex-shrink: 0;

    b {
      font-weight: 600;
      color: #303133;
    }
  }

  .status-sep {
    margin: 0 6px;
    color: #c0c4cc;
    flex-shrink: 0;
  }

  .status-selected {
    color: #409eff;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
}
</style>
