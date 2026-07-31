import { inject, provide, type InjectionKey } from "vue";
import type { SerializedSolidData, SerializedTreeNode } from "../../types";
import type { SceneManager, SelectionManager, StepLoader } from "../../core";
import { buildFlatTree } from "../../core/MeshSplitter";
import { splitSolidData } from "../../core/useMeshImportWorker";
import type { MeshImportOptions } from "../../core/MeshImportWorker";
import { useStepViewerStore } from "../../stores/useStepViewerStore";
import { useURDFStore } from "../../stores/useURDFStore";

export interface GeometryEditDeps {
  getStepLoader: () => StepLoader | null;
  getSceneManager: () => SceneManager | null;
  getSelectionManager: () => SelectionManager | null;
  disposeUrdfModules: () => void;
  initUrdfModules: () => void;
  onGeometryChanged?: (solids: SerializedSolidData[], tree: SerializedTreeNode) => void;
}

export interface RebuildOptions {
  fitView?: boolean;
  treeName?: string;
  tree?: SerializedTreeNode | null;
}

export interface SplitResult {
  parts: number;
  sourceName: string;
}

export interface GeometryEditApi {
  hasGeometry: () => boolean;
  currentSolidData: () => SerializedSolidData[];
  rebuild: (dataList: SerializedSolidData[], options?: RebuildOptions) => SerializedTreeNode;
  splitSolids: (solidIds: string[], options?: MeshImportOptions) => Promise<SplitResult[]>;
  replaceGeometry: (
    dataList: SerializedSolidData[],
    options?: RebuildOptions & { keepStructure?: boolean; autoBind?: boolean },
  ) => { bound: number; unmatched: string[] };
  appendGeometry: (dataList: SerializedSolidData[], options?: RebuildOptions) => void;
}

export const GEOMETRY_EDIT_KEY: InjectionKey<GeometryEditApi> = Symbol("geometryEdit");

export function useGeometryEdit(deps: GeometryEditDeps): GeometryEditApi {
  const store = useStepViewerStore();
  const urdfStore = useURDFStore();

  function currentSolidData(): SerializedSolidData[] {
    const list: SerializedSolidData[] = [];
    for (const solid of store.solids) {
      if (solid.serializedData) list.push(solid.serializedData);
    }
    return list;
  }

  function hasGeometry(): boolean {
    return store.solids.length > 0 && store.solids.every((s) => !!s.serializedData);
  }

  function rebuild(dataList: SerializedSolidData[], options?: RebuildOptions): SerializedTreeNode {
    const loader = deps.getStepLoader();
    const sceneManager = deps.getSceneManager();
    if (!loader || !sceneManager) throw new Error("渲染器尚未就绪");

    const tree =
      options?.tree ??
      buildFlatTree(
        options?.treeName || store.currentFileName || "Model",
        dataList.map((d, i) => d.name || `Solid_${i}`),
      );

    deps.disposeUrdfModules();
    sceneManager.clearModels();

    const restored = loader.restoreScene(dataList, tree);
    sceneManager.addModel(restored.group);

    store.setSolids(restored.solids);
    store.setTreeNodes(restored.treeNodes);

    const selectionManager = deps.getSelectionManager();
    if (selectionManager) {
      selectionManager.clearSelection();
      selectionManager.setSolids(restored.solids);
      for (const solid of restored.solids) {
        if (!store.isSolidVisible(solid.id)) selectionManager.setVisibility(solid.id, false);
      }
      selectionManager.setOpacity(null, store.globalOpacity);
    }

    store.setSelectedFeatures([]);
    store.clearTreeSelection();

    deps.initUrdfModules();
    if (options?.fitView) sceneManager.fitToModel();
    sceneManager.markDirty();

    if (restored.solids.length === 0 || sceneManager.sceneTriangles === 0) {
      throw new Error("几何重建失败：没有生成任何可渲染的三角面");
    }

    deps.onGeometryChanged?.(dataList, tree);
    return tree;
  }

  function remapVisibility(mapping: Map<string, string[]>): void {
    const next = new Map<string, boolean>();
    for (const [oldId, visible] of store.solidVisibilityMap) {
      for (const id of mapping.get(oldId) ?? [oldId]) next.set(id, visible);
    }
    store.solidVisibilityMap = next;
  }

  async function splitSolids(
    solidIds: string[],
    options?: MeshImportOptions,
  ): Promise<SplitResult[]> {
    if (!hasGeometry()) throw new Error("部分实体缺少几何数据，无法拆解");

    const ordered = currentSolidData();
    const idOfIndex = store.solids.map((s) => s.id);
    const targets = new Set(solidIds);

    const nextData: SerializedSolidData[] = [];
    const mapping = new Map<string, string[]>();
    const results: SplitResult[] = [];

    for (let i = 0; i < ordered.length; i++) {
      const oldId = idOfIndex[i];
      const data = ordered[i];

      if (!targets.has(oldId)) {
        mapping.set(oldId, [`solid_${nextData.length}`]);
        nextData.push(data);
        continue;
      }

      const parts = await splitSolidData(data, options ?? {});
      if (parts.length <= 1) {
        mapping.set(oldId, [`solid_${nextData.length}`]);
        nextData.push(data);
        results.push({ parts: parts.length, sourceName: data.name });
        continue;
      }

      const newIds: string[] = [];
      for (const part of parts) {
        newIds.push(`solid_${nextData.length}`);
        nextData.push(part);
      }
      mapping.set(oldId, newIds);
      results.push({ parts: parts.length, sourceName: data.name });
    }

    const grew = nextData.length !== ordered.length;
    if (grew) {
      urdfStore.remapSolidIds(mapping);
      remapVisibility(mapping);
      rebuild(nextData);
    }

    return results;
  }

  function replaceGeometry(
    dataList: SerializedSolidData[],
    options?: RebuildOptions & { keepStructure?: boolean; autoBind?: boolean },
  ): { bound: number; unmatched: string[] } {
    if (dataList.length === 0) throw new Error("没有可用的几何数据");

    if (options?.keepStructure) {
      urdfStore.clearSolidBindings();
    } else {
      urdfStore.clearAll();
    }

    store.solidVisibilityMap = new Map();
    rebuild(dataList, { fitView: true, ...options });

    if (options?.keepStructure && options.autoBind !== false) {
      const result = urdfStore.bindSolidsByName(
        store.solids.map((s) => ({ id: s.id, name: s.name })),
      );
      return { bound: result.bound, unmatched: result.unmatchedSolids };
    }

    return { bound: 0, unmatched: [] };
  }

  function appendGeometry(dataList: SerializedSolidData[], options?: RebuildOptions): void {
    if (dataList.length === 0) return;
    const ordered = currentSolidData();
    const mapping = new Map<string, string[]>();
    store.solids.forEach((solid, index) => mapping.set(solid.id, [`solid_${index}`]));
    urdfStore.remapSolidIds(mapping);
    rebuild([...ordered, ...dataList], options);
  }

  const api: GeometryEditApi = {
    hasGeometry,
    currentSolidData,
    rebuild,
    splitSolids,
    replaceGeometry,
    appendGeometry,
  };

  provide(GEOMETRY_EDIT_KEY, api);
  return api;
}

export function useGeometryEditApi(): GeometryEditApi | null {
  return inject(GEOMETRY_EDIT_KEY, null);
}
