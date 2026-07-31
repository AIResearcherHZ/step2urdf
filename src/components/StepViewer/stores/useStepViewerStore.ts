import { defineStore } from "pinia";
import { ref, computed, markRaw } from "vue";
import * as THREE from "three";
import type { SolidObject, GeometryFeature, UploadProgress, TreeNode } from "../types";
import type { LineMeasurementData } from "../core/LineMeasurementTool";

export const useStepViewerStore = defineStore("stepViewer", () => {
  const uploadProgress = ref<UploadProgress>({
    status: "idle",
    progress: 0,
    message: "",
  });

  const solids = ref<SolidObject[]>([]);
  const modelRotationElements = ref<number[] | null>(null);
  const currentFileName = ref<string>("");

  const treeNodes = ref<TreeNode[]>([]);
  const selectedTreeNodeIds = ref<string[]>([]);
  const expandedTreeNodeIds = ref<string[]>([]);
  const treeNodeCount = ref(0);

  const sidePanelVisible = ref(true);
  const sidePanelWidth = ref(280);

  const selectedFeatures = ref<GeometryFeature[]>([]);

  const lineMeasurements = ref<LineMeasurementData[]>([]);
  const isLineMeasureActive = ref(false);

  const showAxes = ref(false);
  const showGrid = ref(true);
  const globalOpacity = ref(0.3);
  const isTransparent = ref(false);

  const solidVisibilityMap = ref(new Map<string, boolean>());

  const hasModel = computed(() => solids.value.length > 0);

  const isLoading = computed(
    () => uploadProgress.value.status === "uploading" || uploadProgress.value.status === "parsing",
  );

  const firstSelectedFeature = computed(() => selectedFeatures.value[0] || null);

  const secondSelectedFeature = computed(() => selectedFeatures.value[1] || null);

  const canMeasure = computed(() => selectedFeatures.value.length === 2);

  const featureStats = computed(() => {
    const stats: Record<string, number> = {};
    solids.value.forEach((solid) => {
      solid.features.forEach((feature) => {
        const type = feature.type;
        stats[type] = (stats[type] || 0) + 1;
      });
    });
    return stats;
  });

  const flatTreeNodes = computed(() => {
    const result: TreeNode[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (node.children) walk(node.children);
      }
    };
    walk(treeNodes.value);
    return result;
  });

  const selectedTreeNodeIdSet = computed(() => new Set(selectedTreeNodeIds.value));

  const solidMap = computed(() => {
    const map = new Map<string, SolidObject>();
    solids.value.forEach((s) => map.set(s.id, s));
    return map;
  });

  const selectedSolidNames = computed(() => {
    return selectedTreeNodeIds.value
      .map((id) => flatTreeNodes.value.find((n) => n.id === id))
      .filter(Boolean)
      .map((n) => n!.name);
  });

  function updateUploadProgress(progress: Partial<UploadProgress>): void {
    uploadProgress.value = { ...uploadProgress.value, ...progress };
  }

  function setSolids(newSolids: SolidObject[]): void {
    for (const solid of newSolids) {
      if (solid.mesh) markRaw(solid.mesh);
      if (solid.serializedData) markRaw(solid.serializedData as any);
      if (solid.edgeLines) markRaw(solid.edgeLines);
      if (solid.topologyEdges) markRaw(solid.topologyEdges);
    }
    solids.value = newSolids;
  }

  function getModelRotation(): THREE.Matrix4 {
    const m = new THREE.Matrix4();
    if (modelRotationElements.value) m.fromArray(modelRotationElements.value);
    return m;
  }

  function setModelRotation(m: THREE.Matrix4): void {
    modelRotationElements.value = m.toArray();
  }

  const isModelRotated = computed(() => {
    const e = modelRotationElements.value;
    if (!e) return false;
    const identity = new THREE.Matrix4().toArray();
    return e.some((v, i) => Math.abs(v - identity[i]) > 1e-12);
  });

  function setTreeNodes(nodes: TreeNode[]): void {
    treeNodes.value = nodes;
    const idsToExpand: string[] = [];
    let count = 0;
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        count++;
        if (n.type === "root" || n.type === "compound") {
          idsToExpand.push(n.id);
        }
        if (n.children) walk(n.children);
      }
    };
    walk(nodes);
    expandedTreeNodeIds.value = idsToExpand;
    treeNodeCount.value = count;
  }

  function selectTreeNode(nodeId: string, multi = false): void {
    if (multi) {
      const idx = selectedTreeNodeIds.value.indexOf(nodeId);
      if (idx >= 0) {
        selectedTreeNodeIds.value.splice(idx, 1);
      } else {
        selectedTreeNodeIds.value.push(nodeId);
      }
    } else {
      selectedTreeNodeIds.value = [nodeId];
    }
  }

  function syncTreeFromSelection(treeNodeIds: string[]): void {
    selectedTreeNodeIds.value = [...treeNodeIds];
  }

  function clearTreeSelection(): void {
    selectedTreeNodeIds.value = [];
  }

  function setFileName(name: string): void {
    currentFileName.value = name;
  }

  function clearModel(): void {
    solids.value = [];
    modelRotationElements.value = null;
    currentFileName.value = "";
    selectedFeatures.value = [];
    lineMeasurements.value = [];
    isLineMeasureActive.value = false;
    isTransparent.value = false;
    treeNodes.value = [];
    selectedTreeNodeIds.value = [];
    expandedTreeNodeIds.value = [];
    solidVisibilityMap.value = new Map();
    uploadProgress.value = {
      status: "idle",
      progress: 0,
      message: "",
    };
  }

  function setSelectedFeatures(features: GeometryFeature[]): void {
    selectedFeatures.value = features;
  }

  function clearSelection(): void {
    selectedFeatures.value = [];
    selectedTreeNodeIds.value = [];
  }

  function addLineMeasurement(line: LineMeasurementData): void {
    lineMeasurements.value.push(line);
  }

  function removeLineMeasurement(id: string): void {
    const idx = lineMeasurements.value.findIndex((l) => l.id === id);
    if (idx > -1) lineMeasurements.value.splice(idx, 1);
  }

  function clearLineMeasurements(): void {
    lineMeasurements.value = [];
  }

  function setLineMeasureActive(active: boolean): void {
    isLineMeasureActive.value = active;
  }

  function toggleSolidVisibility(solidId: string): void {
    const current = solidVisibilityMap.value.get(solidId) ?? true;
    solidVisibilityMap.value.set(solidId, !current);
    solidVisibilityMap.value = new Map(solidVisibilityMap.value);
  }

  function isSolidVisible(solidId: string): boolean {
    return solidVisibilityMap.value.get(solidId) ?? true;
  }

  function toggleSidePanel(): void {
    sidePanelVisible.value = !sidePanelVisible.value;
  }

  function setSidePanelWidth(width: number): void {
    sidePanelWidth.value = Math.max(120, Math.min(500, width));
  }

  function setShowAxes(show: boolean): void {
    showAxes.value = show;
  }

  function setShowGrid(show: boolean): void {
    showGrid.value = show;
  }

  function setGlobalOpacity(opacity: number): void {
    globalOpacity.value = opacity;
  }

  function setTransparent(value: boolean): void {
    isTransparent.value = value;
  }

  return {
    uploadProgress,
    solids,
    currentFileName,
    treeNodes,
    selectedTreeNodeIds,
    expandedTreeNodeIds,
    sidePanelVisible,
    sidePanelWidth,
    selectedFeatures,
    lineMeasurements,
    isLineMeasureActive,
    showAxes,
    showGrid,
    globalOpacity,
    isTransparent,
    solidVisibilityMap,

    hasModel,
    isLoading,
    firstSelectedFeature,
    secondSelectedFeature,
    canMeasure,
    featureStats,
    flatTreeNodes,
    selectedTreeNodeIdSet,
    selectedSolidNames,
    solidMap,
    treeNodeCount,
    isModelRotated,

    updateUploadProgress,
    setSolids,
    getModelRotation,
    setModelRotation,
    setFileName,
    setTreeNodes,
    selectTreeNode,
    syncTreeFromSelection,
    clearTreeSelection,
    clearModel,
    setSelectedFeatures,
    clearSelection,
    addLineMeasurement,
    removeLineMeasurement,
    clearLineMeasurements,
    setLineMeasureActive,
    toggleSolidVisibility,
    isSolidVisible,
    toggleSidePanel,
    setSidePanelWidth,
    setShowAxes,
    setShowGrid,
    setGlobalOpacity,
    setTransparent,
  };
});
