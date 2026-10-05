<script setup lang="ts">
import { computed } from "vue";
import { NAlert, NButton, NCard, NEmpty, NTable, NTag, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";

const store = useReviewStore();
const message = useMessage();

const columns = [
  { title: "名次", key: "rank", width: 70 },
  { title: "匿名编号", key: "code" },
  { title: "方案", key: "title" },
  { title: "有效评委", key: "judgeCount" },
  { title: "利益冲突", key: "conflicts" },
  { title: "加权总分", key: "total" }
];

const schemeRows = computed(() =>
  store.schemes.map((scheme) => {
    const rows = store.scores.filter(
      (score) => score.schemeId === scheme.id && score.submitted && !score.superseded
    );
    return {
      ...scheme,
      submitted: rows.length,
      total: store.judges.length,
      confirmed: rows.length > 0 && rows.every((score) => score.confirmed),
      rows
    };
  })
);

/** 待回避裁定：申报后尚未作出回避结论的评分 */
const pendingRecusals = computed(() =>
  store.scores.filter((score) => !score.superseded && score.recusal === "pending")
);

/** 已作出回避结论、留档核查的评分 */
const adjudicated = computed(() =>
  store.scores.filter((score) => !score.superseded && (score.recusal === "recused" || score.recusal === "cleared"))
);

/** 被替代的原版本：原分与评语留作核查依据 */
const archived = computed(() => store.scores.filter((score) => score.superseded));

function publish() {
  const complete = store.schemes.every((scheme) => store.allSubmittedFor(scheme.id));
  if (!complete) {
    message.warning("仍有评委未提交，不能锁定结果");
    return;
  }
  const result = store.publish();
  if (!result.ok) {
    if (result.reason === "裁定未结束") {
      message.warning(
        `仍有裁定未结束（回避待裁定 ${result.pendingRecusal} 份、待复核 ${result.pendingReview} 份），所有裁定结束才能锁定`
      );
    }
    return;
  }
  message.success("评分结果已锁定发布");
}
</script>

<template>
  <NAlert v-if="!store.published" type="warning" show-icon>
    结果尚未锁定。为避免影响独立判断，主办方当前只能看到提交进度；锁定须待所有回避申报与待复核裁定结束。
  </NAlert>

  <NAlert v-if="store.pendingRecusalCount > 0 || store.pendingReviewCount > 0" type="error" show-icon class="gate-alert">
    尚有 {{ store.pendingRecusalCount }} 份回避申报待裁定、{{ store.pendingReviewCount }} 份晚到提交待复核，结果作废重算中，不能锁定。
  </NAlert>

  <div class="result-grid">
    <NCard title="提交进度">
      <article v-for="scheme in schemeRows" :key="scheme.id" class="progress-row">
        <div>
          <b>{{ scheme.code }} {{ scheme.title }}</b>
          <small>{{ scheme.submitted }} / {{ scheme.total }} 已提交<template v-if="scheme.confirmed"> · 已确认</template></small>
        </div>
        <div class="row-actions">
          <NTag :type="store.allSubmittedFor(scheme.id) ? 'success' : 'warning'">
            {{ store.allSubmittedFor(scheme.id) ? "齐备" : "待提交" }}
          </NTag>
          <NButton
            v-if="store.allSubmittedFor(scheme.id) && !scheme.confirmed && !store.published"
            size="small"
            @click="store.confirmScheme(scheme.id)"
          >确认提交状态</NButton>
        </div>
      </article>
    </NCard>

    <NCard title="评分纪律">
      <div class="discipline">
        <p>评委只能查看自己的评分，主办方在锁定前无法读取分值。</p>
        <p>回避申报后已交评分是否继续算数须重新裁定，原分和评语留作核查依据。</p>
        <p>同一评委的晚到提交先停待复核区，不覆盖已确认状态；复核中的评分不参加排名。</p>
        <p>评委越权改他人评分直接拒绝；保存失败留住申报和草稿，可重试。</p>
      </div>
      <NButton type="primary" block :disabled="store.published" @click="publish">锁定并发布结果</NButton>
    </NCard>
  </div>

  <NCard v-if="store.pendingReviewCount > 0" title="待复核区（同一评委晚到的设备提交）" class="review-card">
    <NAlert type="info" show-icon class="review-hint">晚到提交未覆盖主办方刚确认的状态，待裁定是否采纳；复核中的评分不参加排名。</NAlert>
    <article v-for="pending in store.pendingReviews" :key="pending.id" class="review-row">
      <div>
        <b>{{ pending.judge }} · {{ store.schemes.find((s) => s.id === pending.schemeId)?.code }}</b>
        <small>{{ pending.arrivedAt }}<template v-if="pending.conflict"> · 附回避申报</template></small>
        <p class="review-comment">“{{ pending.comment || "（无评语）" }}”</p>
      </div>
      <div class="row-actions">
        <NButton size="small" type="primary" @click="store.reviewPending(pending.id, true)">采纳</NButton>
        <NButton size="small" @click="store.reviewPending(pending.id, false)">驳回</NButton>
      </div>
    </article>
  </NCard>

  <NCard v-if="pendingRecusals.length" title="回避裁定（已交评分是否继续算数）" class="review-card">
    <article v-for="score in pendingRecusals" :key="score.id" class="review-row">
      <div>
        <b>{{ score.judge }} · {{ store.schemes.find((s) => s.id === score.schemeId)?.code }}</b>
        <small>评委申报利益冲突 · 原分与评语留作核查</small>
        <p class="review-comment">“{{ score.comment || "（无评语）" }}”</p>
      </div>
      <div class="row-actions">
        <NButton size="small" type="error" @click="store.adjudicateRecusal(score.id, 'recused')">裁定回避</NButton>
        <NButton size="small" type="primary" @click="store.adjudicateRecusal(score.id, 'cleared')">裁定不回避</NButton>
      </div>
    </article>
  </NCard>

  <NCard v-if="adjudicated.length" title="已裁定留档" class="review-card">
    <article v-for="score in adjudicated" :key="score.id" class="review-row">
      <div>
        <b>{{ score.judge }} · {{ store.schemes.find((s) => s.id === score.schemeId)?.code }}</b>
        <small>{{ score.recusal === "recused" ? "回避 · 评分不计入排名，原分留档" : "不回避 · 评分有效" }}</small>
      </div>
      <NTag :type="score.recusal === 'recused' ? 'error' : 'success'">
        {{ score.recusal === "recused" ? "回避" : "有效" }}
      </NTag>
    </article>
  </NCard>

  <NCard v-if="archived.length" title="评分留档（原分与评语核查依据）" class="review-card">
    <article v-for="score in archived" :key="score.id" class="review-row">
      <div>
        <b>{{ score.judge }} · {{ store.schemes.find((s) => s.id === score.schemeId)?.code }}</b>
        <small>已被新版本替代 · {{ score.updatedAt }}</small>
        <p class="review-comment">“{{ score.comment || "（无评语）" }}”</p>
      </div>
      <NTag type="default">原版本留档</NTag>
    </article>
  </NCard>

  <NCard title="最终排名" class="ranking">
    <NEmpty v-if="!store.published" description="锁定后查看最终排名" />
    <NTable v-else :columns="columns" :data="store.ranking.map((item, index) => ({ ...item, rank: index + 1 }))" :bordered="false" />
  </NCard>
</template>
