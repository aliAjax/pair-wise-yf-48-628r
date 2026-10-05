<script setup lang="ts">
import { computed, h, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NRate, NSelect, NSwitch, NTag, useMessage } from "naive-ui";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useReviewStore } from "../stores/review";
import type { DeviceId } from "../types";

const store = useReviewStore();
const message = useMessage();
const selectedId = defineModel<string>("selectedId", { default: "a" });
const selected = computed(() => store.schemes.find((item) => item.id === selectedId.value) ?? store.schemes[0]);
const currentScore = computed(() => store.record(selected.value.id));
const device = ref<DeviceId>("设备A");
const deviceOptions = [{ label: "设备A（主机）", value: "设备A" }, { label: "设备B（异地登录）", value: "设备B" }];
const form = reactive({ values: Object.fromEntries(store.criteria.map((item) => [item.id, 60])) as Record<string, number>, comment: "", conflict: false });
const recusalReason = ref("");
const schema = toTypedSchema(z.object({ comment: z.string().min(4, "请至少填写4个字的评审意见") }));
const { errors, validate } = useForm({ validationSchema: schema });

function hydrate() {
  const record = store.record(selected.value.id);
  const queued = store.outbox.find((item) => item.judge === store.viewer && item.schemeId === selected.value.id && item.type === "草稿");
  form.values = { ...(queued?.values ?? record?.values ?? Object.fromEntries(store.criteria.map((item) => [item.id, 60]))) };
  form.comment = queued?.comment ?? record?.comment ?? "";
  form.conflict = queued?.conflict ?? record?.conflict ?? false;
  recusalReason.value = store.reviews.find(
    (item) => item.kind === "回避申报" && item.judge === store.viewer && item.schemeId === selected.value.id
  )?.reason ?? "";
}
watch(selectedId, hydrate, { immediate: true });
watch(() => store.viewer, hydrate);

const weighted = computed(() => store.criteria.reduce((sum, item) => sum + form.values[item.id] * item.weight / 100, 0));
const myReviews = computed(() => store.reviews.filter((item) => item.judge === store.viewer && item.schemeId === selected.value.id));
const hasPending = computed(() => myReviews.value.some((item) => item.status === "待复核"));
const disabled = computed(() => store.isOrganizer || store.published || hasPending.value);
const myOutbox = computed(() => store.outbox.filter((item) => item.judge === store.viewer));

function reviewTagType(status: string) {
  if (status === "待复核") return "warning";
  if (status === "不计分" || status === "驳回") return "error";
  return "success";
}

function draft() {
  store.saveDraft(selected.value.id, form.values, form.comment, form.conflict, device.value);
  message[store.networkOn ? "success" : "warning"](
    store.networkOn ? `评分草稿已保存（${device.value}）` : "网络中断：草稿已留在本机，恢复后可一键重试，表单内容未丢"
  );
}
async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  const outcome = store.submit(selected.value.id, form.values, form.comment, form.conflict, device.value);
  if (outcome === "parked") message.warning("检测到另一台设备已有确认提交：晚到这份已停入主办方待复核区，不会覆盖原状态");
  else if (outcome === "offline") message.warning("网络中断：提交已留在本机待重发，恢复网络后点“重试留存内容”");
  else if (outcome === "blocked") message.error("该方案存在待复核裁定，暂时不能提交");
  else message.success(`匿名评分已提交（${device.value}）`);
}
function recuse() {
  const outcome = store.declareRecusal(selected.value.id, recusalReason.value, device.value);
  if (outcome === "blocked") message.error("请填写回避理由，且同一方案不能重复提出待裁申报");
  else if (outcome === "offline") message.warning("网络中断：回避申报已留在本机待重发，原分与评语同步留档");
  else message.success("回避申报已提交主办方重新裁定，裁定前原分暂不计入排名");
}
async function retryOutbox() {
  if (!store.networkOn) { message.error("网络仍中断，继续保留草稿与申报"); return; }
  const done = store.flushOutbox();
  if (done) { message.success(`${done} 份留存内容重试成功`); hydrate(); }
  else message.info("没有可重试的内容");
}
const retryAction = () => h(NButton, { size: "small", type: "primary", onClick: retryOutbox }, { default: () => "重试留存内容" });
/** 演示纪律红线：评委越权改另一位评委的评分，服务端规则直接拒绝 */
function tamper() {
  const other = store.judges.find((name) => name !== store.viewer) ?? store.judges[0];
  const rejected = store.attemptUnauthorizedEdit(other, selected.value.id);
  if (rejected) message.error(`越权操作被直接拒绝：你不能修改 ${other} 的评分，事件已记入审计`);
}
</script>

<template>
  <NAlert v-if="store.isOrganizer" type="info" show-icon>主办方在结果锁定前不能查看任何评委的评分值，回避裁定仅展示申报理由与结论。</NAlert>
  <template v-else>
    <NAlert v-if="myOutbox.length" type="warning" show-icon style="margin-bottom:12px"
      :action="retryAction">
      本机有 {{ myOutbox.length }} 份因保存失败留住的{{ myOutbox.map((i) => i.type).join("、") }}（已尝试 {{ myOutbox[0].attempts }} 次），表单内容与申报均未丢失。
    </NAlert>
    <div class="sim-bar">
      <div class="sim-item"><small>提交设备</small><NSelect :value="device" :options="deviceOptions" style="width:180px" @update:value="(v: DeviceId) => (device = v)" /></div>
      <label class="sim-item net"><NSwitch :value="store.networkOn" @update:value="(v: boolean) => store.setNetwork(v)" /><span><b>网络{{ store.networkOn ? "正常" : "中断（演练）" }}</b><small>中断时保存/提交/申报会留在本机待重发</small></span></label>
      <NButton size="small" quaternary type="error" @click="tamper">越权演练：改另一位评委的评分</NButton>
    </div>

    <NAlert v-if="hasPending" type="warning" show-icon style="margin:12px 0">本方案存在待主办方裁定的事项，评分与退回均已冻结，复核中的评分不参加排名。</NAlert>
    <div v-for="item in myReviews" :key="item.id" class="review-line">
      <NTag :type="reviewTagType(item.status)" size="small">{{ item.kind }} · {{ item.status }}</NTag>
      <small>{{ item.kind === "重复提交" ? `${item.deviceId} 晚到副本停在待复核区，已确认状态受保护` : `理由：${item.reason}；原分与评语留档核查` }}</small>
    </div>
  </template>

  <div class="workspace">
    <NCard title="匿名方案" class="scheme-panel"><button v-for="item in store.schemes" :key="item.id" class="scheme" :class="{ active: selectedId === item.id }" @click="selectedId = item.id"><span>{{ item.code }}</span><b>{{ item.title }}</b><small>{{ item.publicNo }} · {{ item.status }}</small></button></NCard>
    <NCard class="score-panel">
      <template #header><div class="card-title"><div><small>{{ selected.code }} · {{ selected.publicNo }}</small><h2>{{ selected.title }}</h2></div><NTag :type="selected.status === '已锁定' ? 'success' : 'warning'">{{ selected.status }}</NTag></div></template>
      <p class="synopsis">{{ selected.synopsis }}</p>
      <div class="criteria">
        <article v-for="item in store.criteria" :key="item.id"><div><b>{{ item.name }}</b><span>权重 {{ item.weight }}%</span><p>{{ item.description }}</p></div><NRate v-model:value="form.values[item.id]" :count="5" :disabled="disabled" /><small>{{ form.values[item.id] }} / {{ item.max }}</small></article>
      </div>
      <div class="weighted"><span>加权得分</span><NProgress type="line" :percentage="weighted" :height="18" /><b>{{ weighted.toFixed(1) }}</b></div>
      <label class="conflict-switch"><NSwitch v-model:value="form.conflict" :disabled="disabled" /><span><b>声明利益冲突</b><small>声明后进入主办方裁定流程，裁定计分前不参与排名</small></span></label>
      <label class="field"><span>评审意见（评委间不可见，原评语始终留档核查）</span><NInput v-model:value="form.comment" type="textarea" :disabled="disabled" placeholder="填写对方案的具体意见" /><small>{{ errors.comment }}</small></label>

      <div class="recusal-box">
        <div class="recusal-head"><b>回避申报（锁定前可对已交评分提出）</b><small>提出后已交评分是否算数由主办方重新裁定；裁定期间有效评委数与名次按最新结论重算</small></div>
        <div class="recusal-row">
          <NInput v-model:value="recusalReason" :disabled="disabled || store.published" placeholder="填写回避理由，例如：近三年与申报单位存在项目合作" />
          <NButton :disabled="disabled || store.published" @click="recuse">提出回避申报</NButton>
        </div>
      </div>

      <div class="actions"><NButton :disabled="disabled" @click="draft">保存草稿</NButton><NButton type="primary" :disabled="disabled" @click="submit">提交本方案评分</NButton><NButton v-if="currentScore?.submitted && !store.published && !hasPending" quaternary @click="store.recalled(selected.id)">退回修改</NButton></div>
    </NCard>
  </div>
</template>
