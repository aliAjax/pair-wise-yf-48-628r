<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NRate, NSwitch, NTag, useMessage } from "naive-ui";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useReviewStore } from "../stores/review";

const store = useReviewStore();
const message = useMessage();
const selectedId = defineModel<string>("selectedId", { default: "a" });
const selected = computed(() => store.schemes.find((item) => item.id === selectedId.value) ?? store.schemes[0]);
const currentScore = computed(() => store.record(selected.value.id));
const form = reactive({
  values: Object.fromEntries(store.criteria.map((item) => [item.id, 60])) as Record<string, number>,
  comment: "",
  conflict: false
});
const schema = toTypedSchema(z.object({ comment: z.string().min(4, "请至少填写4个字的评审意见") }));
const { errors, validate } = useForm({ validationSchema: schema });

const saveError = ref<string | null>(null);
const lastAction = ref<"draft" | "submit">("draft");

watch(
  selectedId,
  () => {
    const record = store.record(selected.value.id);
    form.values = { ...(record?.values ?? Object.fromEntries(store.criteria.map((item) => [item.id, 60]))) };
    form.comment = record?.comment ?? "";
    form.conflict = record?.conflict ?? false;
    saveError.value = null;
  },
  { immediate: true }
);

const weighted = computed(() => store.criteria.reduce((sum, item) => sum + (form.values[item.id] * item.weight) / 100, 0));
const disabled = computed(
  () => store.isOrganizer || store.published || (currentScore.value?.submitted && !currentScore.value?.confirmed)
);

const recusalTag = computed(() => {
  const state = currentScore.value?.recusal;
  if (state === "pending") return { text: "回避待裁定", type: "warning" as const };
  if (state === "recused") return { text: "已回避 · 评分不计入排名", type: "error" as const };
  if (state === "cleared") return { text: "不回避 · 评分有效", type: "success" as const };
  return null;
});

function draft() {
  lastAction.value = "draft";
  const result = store.saveDraft(selected.value.id, form.values, form.comment, form.conflict);
  if (!result.ok) {
    saveError.value =
      result.reason === "越权"
        ? "保存被拒绝：不能修改他人评分。申报和草稿已保留，可重试保存到本人评分。"
        : "保存失败，申报和草稿已保留，可重试。";
    return;
  }
  saveError.value = null;
  message.success("评分草稿已保存到本地");
}

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  lastAction.value = "submit";
  const outcome = store.submit(selected.value.id, form.values, form.comment, form.conflict);
  if (!outcome.ok) {
    saveError.value =
      outcome.reason === "越权"
        ? "提交被拒绝：不能修改他人评分。申报和草稿已保留，可重试提交本人评分。"
        : "提交失败，申报和草稿已保留，可重试。";
    return;
  }
  saveError.value = null;
  if (outcome.parked) {
    message.warning("该提交晚到，已停入待复核区，未覆盖主办方刚确认的状态");
    // 表单恢复为已确认版本，避免与待复核版本混淆
    const item = store.record(selected.value.id);
    if (item) {
      form.values = { ...item.values };
      form.comment = item.comment;
      form.conflict = item.conflict;
    }
  } else {
    message.success("匿名评分已提交");
  }
}

function retry() {
  saveError.value = null;
  if (lastAction.value === "submit") submit();
  else draft();
}

/** 演练：越权修改他人评分（应被直接拒绝，且草稿保留可重试） */
function overstep() {
  lastAction.value = "draft";
  const result = store.simulateOverstep(selected.value.id);
  if (!result.ok) {
    saveError.value =
      "越权操作被直接拒绝：评委只能修改本人评分。当前申报和草稿已保留，可重试保存到本人评分。";
  }
}
</script>

<template>
  <NAlert v-if="store.isOrganizer" type="info" show-icon>主办方在结果锁定前不能查看任何评委的评分值。</NAlert>
  <div class="workspace">
    <NCard title="匿名方案" class="scheme-panel">
      <button v-for="item in store.schemes" :key="item.id" class="scheme" :class="{ active: selectedId === item.id }" @click="selectedId = item.id">
        <span>{{ item.code }}</span><b>{{ item.title }}</b><small>{{ item.publicNo }} · {{ item.status }}</small>
      </button>
    </NCard>
    <NCard class="score-panel">
      <template #header>
        <div class="card-title">
          <div><small>{{ selected.code }} · {{ selected.publicNo }}</small><h2>{{ selected.title }}</h2></div>
          <NTag :type="selected.status === '已锁定' ? 'success' : 'warning'">{{ selected.status }}</NTag>
        </div>
      </template>
      <p class="synopsis">{{ selected.synopsis }}</p>
      <div class="criteria">
        <article v-for="item in store.criteria" :key="item.id">
          <div><b>{{ item.name }}</b><span>权重 {{ item.weight }}%</span><p>{{ item.description }}</p></div>
          <NRate v-model:value="form.values[item.id]" :count="5" :disabled="disabled" /><small>{{ form.values[item.id] }} / {{ item.max }}</small>
        </article>
      </div>
      <div class="weighted"><span>加权得分</span><NProgress type="line" :percentage="weighted" :height="18" /><b>{{ weighted.toFixed(1) }}</b></div>
      <label class="conflict-switch">
        <NSwitch v-model:value="form.conflict" :disabled="disabled" />
        <span><b>声明利益冲突</b><small>申报后已交评分是否继续算数需重新裁定，原分和评语留作核查依据</small></span>
        <NTag v-if="recusalTag" :type="recusalTag.type" class="recusal-tag">{{ recusalTag.text }}</NTag>
      </label>
      <label class="field">
        <span>评审意见（评委间不可见）</span>
        <NInput v-model:value="form.comment" type="textarea" :disabled="disabled" placeholder="填写对方案的具体意见" />
        <small>{{ errors.comment }}</small>
      </label>
      <NAlert v-if="saveError" type="error" show-icon class="save-error">
        {{ saveError }}
        <NButton size="small" type="primary" class="retry-btn" @click="retry">重试保存</NButton>
      </NAlert>
      <div class="actions">
        <NButton :disabled="disabled" @click="draft">保存草稿</NButton>
        <NButton type="primary" :disabled="disabled" @click="submit">提交本方案评分</NButton>
        <NButton v-if="currentScore?.submitted && !store.published && !currentScore?.confirmed" quaternary @click="store.recalled(selected.id)">退回修改</NButton>
        <NButton v-if="!store.isOrganizer" quaternary type="error" @click="overstep">演练：越权修改他人评分</NButton>
      </div>
    </NCard>
  </div>
</template>
