<template>
  <div class="view-controls">
    <div class="control-row">
      <span class="control-label">显示关节坐标系</span>
      <el-switch v-model="urdfStore.showFrames" />
    </div>
    <div class="control-row axis-row">
      <span class="control-label">轴长库尺</span>
      <el-slider
        v-model="urdfStore.axisHelperScale"
        :min="0.1"
        :max="5"
        :step="0.1"
        :show-tooltip="true"
        :format-tooltip="(v: number) => v.toFixed(1) + 'x'"
        style="flex: 1; min-width: 60px"
      />
      <span class="axis-value">{{ urdfStore.axisHelperScale.toFixed(1) }}x</span>
    </div>

    <div class="control-row">
      <el-button type="primary" plain style="width: 100%" @click="openInertiaDialog">
        整机惯量计算
      </el-button>
    </div>

    <el-divider class="zup-divider" />

    <div class="zup-section">
      <div class="control-row">
        <span class="control-label">整机旋转到 Z-up</span>
        <el-tag v-if="stepStore.isModelRotated" size="small" type="success" effect="light"
          >已旋转</el-tag
        >
      </div>
      <div class="control-row zup-axis-row">
        <span class="zup-hint">当前朝上轴</span>
        <el-select v-model="currentUpAxis" size="small" style="width: 92px">
          <el-option v-for="ax in UP_AXIS_OPTIONS" :key="ax" :label="ax" :value="ax" />
        </el-select>
      </div>
      <div class="control-row zup-actions">
        <el-tooltip
          content="把整机几何、关节、惯量与基坐标系一并旋转，使所选轴指向 +Z；该操作会改写几何数据"
          placement="top"
        >
          <el-button
            type="warning"
            plain
            size="small"
            :disabled="!stepStore.hasModel"
            @click="emit('rotateToZUp', currentUpAxis)"
          >
            🧭 旋转到 Z-up
          </el-button>
        </el-tooltip>
        <el-button
          text
          size="small"
          :disabled="!stepStore.isModelRotated"
          @click="emit('resetOrientation')"
        >
          恢复原始朝向
        </el-button>
      </div>

      <el-tooltip
        content="按拓扑顺序把每个关节的坐标轴都对齐到全局 Z-up 右手系（rpy 全部归零），旋转轴改用向量表达；轴心、轴向与整机运动学保持不变"
        placement="top"
      >
        <el-button
          text
          type="primary"
          size="small"
          style="width: 100%; margin-top: 2px"
          :disabled="urdfStore.robot.joints.length === 0"
          @click="alignAllJointFrames"
        >
          全部关节坐标轴对齐 Z-up
        </el-button>
      </el-tooltip>
    </div>
  </div>

  <el-dialog
    v-model="inertiaDialogVisible"
    title="整机惯量计算"
    width="780px"
    :close-on-click-modal="false"
    append-to-body
  >
    <div class="inertia-dialog-body">
      <el-alert
        title="展开连杆可为每个 Solid 单独设置质量；连杆质心按各 Solid 质量加权求得，惯量按平行轴定理精确合成"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
      />

      <div class="param-row">
        <span class="param-label">整机总质量</span>
        <el-input-number
          v-model="totalMass"
          :min="0.001"
          :max="100000"
          :precision="3"
          :step="1"
          controls-position="right"
          style="width: 160px"
        />
        <span class="param-unit">kg</span>
      </div>

      <div v-if="computing" class="progress-row">
        <el-icon class="is-loading">
          <Loading />
        </el-icon>
        <span>{{ progressText }}</span>
      </div>

      <div v-if="computedResults.length > 0" class="result-section">
        <el-divider style="margin: 10px 0" />
        <div class="result-header">
          <span class="result-title">计算结果（共 {{ computedResults.length }} 个连杆）</span>
          <div class="header-actions">
            <el-button text type="info" @click="redistributeByVolume">按体积重新分配</el-button>
            <el-button type="success" plain @click="applyResults">应用到所有连杆</el-button>
          </div>
        </div>
        <el-table
          :data="computedResults"
          :row-key="(row: ResultRow) => row.linkId"
          style="margin-top: 4px"
        >
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="solid-detail">
                <div class="solid-detail-title">Solid 质量分配（{{ row.solids.length }} 个）</div>
                <div v-for="s in row.solids" :key="s.solidId" class="solid-mass-row">
                  <span class="solid-mass-name" :title="s.name">{{ s.name }}</span>
                  <span class="solid-mass-vol">{{ formatVolume(s.volume) }}</span>
                  <el-input-number
                    v-model="s.mass"
                    :min="0.0001"
                    :max="100000"
                    :precision="4"
                    :step="0.05"
                    controls-position="right"
                    style="width: 132px"
                    @change="recalcRow(row as ResultRow)"
                  />
                  <span class="solid-mass-unit">kg</span>
                  <span class="solid-mass-com">质心 {{ formatCom(s.com) }}</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            prop="name"
            label="连杆"
            min-width="90"
            show-overflow-tooltip
            align="center"
          />
          <el-table-column label="Solids" width="72" align="center">
            <template #default="{ row }">{{ row.solids.length }}</template>
          </el-table-column>
          <el-table-column label="质量 (kg)" width="152" align="center">
            <template #default="{ row }">
              <el-input-number
                v-model="row.mass"
                :min="0.0001"
                :max="100000"
                :precision="4"
                :step="0.1"
                controls-position="right"
                style="width: 136px"
                @change="onLinkMassChange(row as ResultRow)"
              />
            </template>
          </el-table-column>
          <el-table-column label="质心 (mm)" min-width="160" align="center">
            <template #default="{ row }">
              {{ formatCom(row.com) }}
            </template>
          </el-table-column>
        </el-table>
        <p class="edit-hint">
          修改连杆质量会按当前各 Solid 质量比例同步缩放；单独修改 Solid 质量则连杆质量取各 Solid
          之和。
        </p>
      </div>
    </div>

    <template #footer>
      <el-button @click="inertiaDialogVisible = false">关闭</el-button>
      <el-button type="primary" :loading="computing" :disabled="totalMass <= 0" @click="runCompute">
        开始计算
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { ElMessage } from "element-plus";
import { Loading } from "@element-plus/icons-vue";
import { useURDFStore } from "../../stores/useURDFStore";
import { useStepViewerStore } from "../../stores/useStepViewerStore";
import { combineSolidInertia } from "../../core/useInertiaWorker";
import { distributeInertia, type LinkInertiaInput } from "../../core/InertiaDistribution";
import {
  UP_AXIS_OPTIONS,
  alignAllJointFramesToWorldZUp,
  type UpAxis,
} from "../../core/ZUpTransform";
import type { InertialParams, SolidMassEntry } from "../../types";

const emit = defineEmits<{
  (e: "rotateToZUp", up: UpAxis): void;
  (e: "resetOrientation"): void;
}>();

const currentUpAxis = ref<UpAxis>("Y+");

const urdfStore = useURDFStore();
const stepStore = useStepViewerStore();

function alignAllJointFrames(): void {
  const joints = urdfStore.robot.joints;
  if (joints.length === 0) {
    ElMessage.warning("尚未创建任何关节");
    return;
  }

  const applied = alignAllJointFramesToWorldZUp(joints);
  if (applied === 0) {
    ElMessage.warning("所有关节的旋转轴均为零向量，无法对齐");
    return;
  }

  const skipped = joints.length - applied;
  ElMessage.success(
    skipped > 0
      ? `已对齐 ${applied} 个关节坐标轴，${skipped} 个因旋转轴为零向量跳过`
      : `已将全部 ${applied} 个关节坐标轴对齐到全局 Z-up 右手系`,
  );
}

function formatCom(com: [number, number, number]): string {
  return com.map((v) => v.toFixed(2)).join(", ");
}

function formatVolume(vMm3: number): string {
  if (vMm3 >= 1e6) return `${(vMm3 / 1e6).toFixed(3)} dm³`;
  if (vMm3 >= 1e3) return `${(vMm3 / 1e3).toFixed(3)} cm³`;
  return `${vMm3.toFixed(1)} mm³`;
}

const inertiaDialogVisible = ref(false);
const totalMass = computed({
  get: () => urdfStore.totalMass,
  set: (v: number) => {
    urdfStore.totalMass = v;
  },
});
const computing = ref(false);
const progressText = ref("");

interface ResultRow {
  linkId: string;
  name: string;
  mass: number;
  com: [number, number, number];
  inertia: InertialParams["inertia"];
  solids: SolidMassEntry[];
}
const computedResults = ref<ResultRow[]>([]);

function openInertiaDialog(): void {
  computedResults.value = [];
  inertiaDialogVisible.value = true;
}

function recalcRow(row: ResultRow): void {
  const combined = combineSolidInertia(row.solids);
  row.mass = combined.mass;
  row.com = combined.com;
  row.inertia = combined.inertia;
  syncTotalMass();
}

function onLinkMassChange(row: ResultRow): void {
  const current = row.solids.reduce((s, e) => s + e.mass, 0);
  if (!Number.isFinite(row.mass) || row.mass <= 0 || current <= 0) return;
  const k = row.mass / current;
  for (const s of row.solids) s.mass *= k;
  recalcRow(row);
}

function redistributeByVolume(): void {
  const totalVolume = computedResults.value.reduce(
    (s, r) => s + r.solids.reduce((v, e) => v + e.volume, 0),
    0,
  );
  if (totalVolume <= 0) return;
  for (const row of computedResults.value) {
    for (const s of row.solids) {
      s.mass = (s.volume / totalVolume) * totalMass.value;
    }
    recalcRow(row);
  }
  ElMessage.success("已按体积比重新分配质量");
}

function syncTotalMass(): void {
  totalMass.value = parseFloat(computedResults.value.reduce((s, r) => s + r.mass, 0).toFixed(6));
}

async function runCompute(): Promise<void> {
  if (computing.value) return;

  const existingSolidMass = new Map<string, number>();
  for (const row of computedResults.value) {
    for (const s of row.solids) existingSolidMass.set(s.solidId, s.mass);
  }
  let isRerun = computedResults.value.length > 0;
  if (!isRerun) {
    for (const l of urdfStore.robot.links) {
      if (!l.solidMasses) continue;
      for (const [sid, m] of Object.entries(l.solidMasses)) {
        if (m > 0) existingSolidMass.set(sid, m);
      }
    }
    isRerun = existingSolidMass.size > 0;
  }

  computing.value = true;
  progressText.value = "正在收集几何数据…";
  computedResults.value = [];

  try {
    const linkInputs: LinkInertiaInput[] = [];
    for (const l of urdfStore.robot.links) {
      if (l.solidIds.length === 0) continue;
      const pairs: LinkInertiaInput["pairs"] = [];
      for (const sid of l.solidIds) {
        const solid = stepStore.solidMap.get(sid);
        if (solid?.serializedData) {
          pairs.push({ solidId: sid, solidName: solid.name, data: solid.serializedData });
        }
      }
      if (pairs.length > 0) linkInputs.push({ linkId: l.id, name: l.name, pairs });
    }

    if (linkInputs.length === 0) {
      ElMessage.warning("没有绑定几何体的连杆，无法计算");
      return;
    }

    const solidCount = linkInputs.reduce((s, l) => s + l.pairs.length, 0);
    progressText.value = `正在计算 ${linkInputs.length} 个连杆 / ${solidCount} 个 Solid 的参考惯量…`;

    const newResults = await distributeInertia(
      linkInputs,
      totalMass.value,
      isRerun ? existingSolidMass : undefined,
    );

    if (newResults.length === 0) {
      ElMessage.warning("计算结果为空，请检查各连杆是否绑定了有效的几何体");
      return;
    }

    computedResults.value = newResults;
    syncTotalMass();

    const hint = isRerun ? "（已保留手动编辑的 Solid 质量）" : "";
    ElMessage.success(`计算完成，共 ${newResults.length} 个连杆 / ${solidCount} 个 Solid${hint}`);
  } catch (e) {
    ElMessage.error(`计算失败: ${(e as Error).message}`);
  } finally {
    computing.value = false;
    progressText.value = "";
  }
}

function applyResults(): void {
  let count = 0;
  for (const row of computedResults.value) {
    urdfStore.setLinkInertial(row.linkId, {
      mass: row.mass,
      com: row.com,
      inertia: row.inertia,
    });
    urdfStore.setLinkSolidMasses(
      row.linkId,
      Object.fromEntries(row.solids.map((s) => [s.solidId, s.mass])),
    );
    count++;
  }
  ElMessage.success(`已将惯性参数应用到 ${count} 个连杆`);
  inertiaDialogVisible.value = false;
}
</script>

<style lang="scss" scoped>
.view-controls {
  padding: 4px 8px;
}

.control-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 0;
  font-size: 12px;
  color: #303133;
}

.control-label {
  flex-shrink: 0;
  font-size: 14px;
}

.axis-row {
  padding-top: 2px;
}

.axis-value {
  font-size: 10px;
  color: #909399;
  flex-shrink: 0;
  width: 26px;
  text-align: right;
}

.zup-divider {
  margin: 8px 0 4px;
}

.zup-hint {
  font-size: 12px;
  color: #909399;
  flex-shrink: 0;
}

.zup-axis-row {
  padding-top: 0;
}

.zup-actions {
  justify-content: flex-start;
  gap: 8px;
  flex-wrap: wrap;
}

.inertia-dialog-body {
  padding: 0 4px;
}

.param-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.param-label {
  flex-shrink: 0;
  font-size: 16px;
  color: #303133;
  width: 80px;
}

.param-unit {
  font-size: 12px;
  color: #606266;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #409eff;
  margin-bottom: 8px;
}

.result-section {
  .result-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .result-title {
    font-size: 16px;
    color: #606266;
  }

  .edit-hint {
    margin: 6px 0 0;
    font-size: 11px;
    color: #909399;
  }
}

.solid-detail {
  padding: 6px 12px 8px 40px;
  background: #fafbfc;
}

.solid-detail-title {
  font-size: 12px;
  font-weight: 600;
  color: #606266;
  margin-bottom: 6px;
}

.solid-mass-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.solid-mass-name {
  font-size: 12px;
  color: #303133;
  width: 160px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.solid-mass-vol {
  font-size: 11px;
  color: #909399;
  font-family: monospace;
  width: 96px;
  flex-shrink: 0;
  text-align: right;
}

.solid-mass-unit {
  font-size: 11px;
  color: #909399;
  flex-shrink: 0;
}

.solid-mass-com {
  font-size: 11px;
  color: #909399;
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
