<script setup lang="ts">
import { computed } from "vue";
import { NAlert, NButton, NCard, NEmpty, NTable, NTag, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";
import type { ReviewStatus } from "../types";

const store = useReviewStore();
const message = useMessage();
const columns = [
  { title: "名次", key: "rank", width: 70 },
  { title: "匿名编号", key: "code" },
  { title: "方案", key: "title" },
  { title: "有效评委", key: "judgeCount" },
  { title: "回避不计分", key: "conflicts" },
  { title: "复核中", key: "pending" },
  { title: "加权总分", key: "total" }
];

const rankedRows = computed(() => {
  let lastTotal: number | null = null;
  let rank = 0;
  return store.ranking.map((item) => {
    rank += 1;
    if (lastTotal !== null && item.total === lastTotal) {
      return { ...item, rank: rank - 1 + "（并列）" };
    }
    lastTotal = item.total;
    return { ...item, rank };
  });
});

function codeOf(schemeId: string) {
  return store.schemes.find((s) => s.id === schemeId)?.code ?? schemeId;
}
function tagType(status: ReviewStatus) {
  if (status === "待复核") return "warning";
  if (status === "不计分" || status === "驳回") return "error";
  return "success";
}
function decide(id: string, status: Exclude<ReviewStatus, "待复核">, label: string) {
  if (store.decideReview(id, status)) message.success(`已裁定：${label}，有效评委数与名次已作废重算`);
  else message.error("只有主办方可以作出裁定");
}
function publish() {
  if (store.lockBlockers.length) {
    message.warning(store.lockBlockers[0]);
    return;
  }
  store.publish();
  message.success("全部裁定已结束，评分结果按最新名次锁定发布");
}
function flush() {
  if (!store.networkOn) { message.warning("网络仍中断"); return; }
  const done = store.flushOutbox();
  message.info(done ? `${done} 份留存内容已补发到账` : "暂无可重试内容");
}
</script>
<template>
  <NAlert v-if="!store.published" type="warning" show-icon>结果尚未锁定。为避免影响独立判断，主办方当前只能看到提交进度、回避申报理由与复核队列，无法读取评分值与评语。</NAlert>

  <div class="result-grid">
    <NCard title="提交进度与有效评委（预览）">
      <article v-for="scheme in store.schemes" :key="scheme.id" class="progress-row">
        <div>
          <b>{{ scheme.code }} {{ scheme.title }}</b>
          <small>已提交 {{ store.judges.filter((name) => store.scores.some((score) => score.schemeId === scheme.id && score.judge === name && score.submitted)).length }} / {{ store.judges.length }}
            · 当前有效评委 {{ store.effectiveJudgeCount(scheme.id) }} 人（复核中/回避成立暂不计）</small>
        </div>
        <NTag :type="store.allSubmittedFor(scheme.id) ? 'success' : 'warning'">{{ store.allSubmittedFor(scheme.id) ? "齐备" : "待提交" }}</NTag>
      </article>
      <p class="epoch-line">名次当前版本：第 {{ store.rankEpoch }} 版<template v-if="store.lastRankedAt"> · 最近重算 {{ new Date(store.lastRankedAt).toLocaleTimeString() }}</template></p>
    </NCard>

    <NCard title="评分纪律">
      <div class="discipline">
        <p>评委只能查看自己的评分，主办方在锁定前无法读取分值；评委越权改动他人评分将被直接拒绝并记入审计。</p>
        <p>回避申报出现后，原分与评语保留核查，是否计分须重新裁定；结论一变，有效评委数与名次立即作废重算。</p>
        <p>同一评委双设备并发提交时，晚到副本停在待复核区，不得覆盖已确认状态。</p>
        <p>保存失败的草稿与申报留在本机，重试成功后继续；所有裁定结束且无待重发内容方可锁定。</p>
      </div>
      <div v-if="store.outbox.length" class="outbox-strip">
        <NTag type="warning" size="small">{{ store.outbox.length }} 份留存待重试</NTag>
        <NButton size="small" @click="flush">代评委重试（网络恢复后）</NButton>
      </div>
      <NButton type="primary" block :disabled="store.published" @click="publish">锁定并发布结果</NButton>
      <ul v-if="store.lockBlockers.length && !store.published" class="blockers">
        <li v-for="(text, i) in store.lockBlockers" :key="i">⛔ {{ text }}</li>
      </ul>
      <p v-else-if="!store.published" class="blockers ok">✅ 无待裁定、无待重发、提交齐备，可以锁定</p>
    </NCard>
  </div>

  <NCard v-if="store.isOrganizer" title="回避申报与待复核队列" class="review-queue">
    <NEmpty v-if="!store.reviews.length" description="暂无回避申报或重复提交" />
    <table v-else class="queue-table">
      <thead><tr><th>事项</th><th>评委</th><th>方案</th><th>来源</th><th>理由 / 说明</th><th>状态</th><th>裁定</th></tr></thead>
      <tbody>
        <tr v-for="item in store.reviews" :key="item.id">
          <td>{{ item.kind }}</td>
          <td>{{ item.judge }}</td>
          <td>{{ codeOf(item.schemeId) }}</td>
          <td>{{ item.deviceId }}</td>
          <td class="reason">{{ item.kind === "回避申报" ? item.reason : "晚到副本停在复核区，原确认版本受保护；采纳将留档换版，驳回则还原" }}</td>
          <td><NTag :type="tagType(item.status)" size="small">{{ item.status }}</NTag></td>
          <td class="decide-cell">
            <template v-if="item.kind === '回避申报'">
              <NButton size="tiny" type="error" :disabled="item.status === '不计分'" @click="decide(item.id, '不计分', '回避成立，不计分')">成立·不计分</NButton>
              <NButton size="tiny" type="success" :disabled="item.status === '计分'" @click="decide(item.id, '计分', '回避不成立，继续计分')">不成立·计分</NButton>
            </template>
            <template v-else>
              <NButton size="tiny" type="primary" :disabled="item.status === '采纳'" @click="decide(item.id, '采纳', `采纳${item.deviceId}晚到提交`)">采纳晚到</NButton>
              <NButton size="tiny" :disabled="item.status === '驳回'" @click="decide(item.id, '驳回', '驳回晚到，维持原状')">驳回晚到</NButton>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </NCard>

  <NCard title="最终排名" class="ranking">
    <NEmpty v-if="!store.published" description="锁定后查看最终排名；裁定变化会令在算名次作废重算" />
    <template v-else>
      <p class="epoch-line">已按第 {{ store.rankEpoch }} 版有效评委结论锁定 · {{ store.lastRankedAt ? new Date(store.lastRankedAt).toLocaleString() : "" }}</p>
      <NTable :columns="columns" :data="rankedRows" :bordered="false" />
    </template>
  </NCard>

  <NCard title="审计事件（核查依据）" class="audit">
    <NEmpty v-if="!store.events.length" description="暂无事件" />
    <ul v-else class="event-list">
      <li v-for="event in store.events.slice(0, 12)" :key="event.id">
        <NTag size="small" :type="event.action.includes('拒绝') ? 'error' : event.action.includes('重算') ? 'warning' : 'default'">{{ event.action }}</NTag>
        <span class="event-detail">{{ event.detail }}</span>
        <small>{{ event.actor }} · {{ new Date(event.time).toLocaleTimeString() }}</small>
      </li>
    </ul>
  </NCard>
</template>
