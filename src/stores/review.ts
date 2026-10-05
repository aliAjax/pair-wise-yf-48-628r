import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import type { Criterion, PendingReview, RecusalState, ReviewEvent, Scheme, ScoreRecord, Viewer } from "../types";

const KEY = "pair-wise-yf-48/review";
const judges: Viewer[] = ["评委-林策", "评委-周筑"];
const seedSchemes: Scheme[] = [
  { id: "a", code: "S-01", title: "潮间带公共客厅", synopsis: "通过退台屋面把社区活动引向水岸，底层保留可被潮水短暂侵入的公共空间。", publicNo: "投递号 7182", status: "待评分" },
  { id: "b", code: "S-02", title: "风廊共生院", synopsis: "以双庭院组织低能耗社区中心，利用贯穿体量连接既有街巷。", publicNo: "投递号 6610", status: "待评分" },
  { id: "c", code: "S-03", title: "折线工坊", synopsis: "保留旧修理厂桁架，置入可拆装工坊和培训空间。", publicNo: "投递号 8024", status: "待评分" }
];
const criteria: Criterion[] = [
  { id: "site", name: "场地回应", description: "与气候、地貌和周边公共空间的关系", weight: 30, max: 100 },
  { id: "program", name: "功能组织", description: "空间组织、流线和公共性", weight: 25, max: 100 },
  { id: "structure", name: "结构与建造", description: "结构逻辑、材料和建造可行性", weight: 25, max: 100 },
  { id: "sustain", name: "环境策略", description: "节能、碳排和长期维护", weight: 20, max: 100 }
];

function emptyScore(judge: Viewer, schemeId: string): ScoreRecord {
  return {
    id: `${judge}-${schemeId}`,
    judge,
    schemeId,
    values: Object.fromEntries(criteria.map((item) => [item.id, 60])),
    comment: "",
    submitted: false,
    conflict: false,
    recusal: "none",
    confirmed: false,
    superseded: false,
    updatedAt: new Date().toISOString()
  };
}

function normalizeScore(raw: any): ScoreRecord {
  return {
    id: raw.id ?? `${raw.judge}-${raw.schemeId}`,
    judge: raw.judge,
    schemeId: raw.schemeId,
    values: raw.values ?? Object.fromEntries(criteria.map((item) => [item.id, 60])),
    comment: raw.comment ?? "",
    submitted: raw.submitted ?? false,
    conflict: raw.conflict ?? false,
    recusal: (raw.recusal as RecusalState) ?? "none",
    confirmed: raw.confirmed ?? false,
    superseded: raw.superseded ?? false,
    updatedAt: raw.updatedAt ?? new Date().toISOString()
  };
}

export const useReviewStore = defineStore("review", () => {
  const saved = localStorage.getItem(KEY);
  const initial = saved
    ? JSON.parse(saved)
    : { scores: [], events: [], published: false, schemeStatuses: {}, pendingReviews: [] };
  const viewer = ref<Viewer>("评委-林策");
  const schemes = ref<Scheme[]>(
    seedSchemes.map((scheme) => ({ ...scheme, status: initial.schemeStatuses?.[scheme.id] ?? scheme.status }))
  );
  const scores = ref<ScoreRecord[]>((initial.scores ?? []).map(normalizeScore));
  const pendingReviews = ref<PendingReview[]>(initial.pendingReviews ?? []);
  const events = ref<ReviewEvent[]>(initial.events ?? []);
  const published = ref<boolean>(initial.published ?? false);

  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed(() => (viewer.value.startsWith("评委-") ? viewer.value : null));
  const visibleScores = computed(() =>
    isOrganizer.value
      ? scores.value
      : scores.value.filter((score) => score.judge === judge.value && !score.superseded)
  );

  function log(action: string, detail: string) {
    events.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor: viewer.value, action, detail });
  }

  function schemeCode(schemeId: string) {
    return schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId;
  }

  function record(schemeId: string) {
    const currentJudge = judge.value;
    if (!currentJudge) return null;
    let item = scores.value.find(
      (score) => score.judge === currentJudge && score.schemeId === schemeId && !score.superseded
    );
    if (!item) {
      item = emptyScore(currentJudge, schemeId);
      scores.value.push(item);
    }
    return item;
  }

  /** 评委只能改自己的评分；越权直接拒绝并留安全日志 */
  function assertOwns(item: ScoreRecord | null | undefined): boolean {
    if (!item) return false;
    if (isOrganizer.value) {
      log("越权操作被拒绝", "主办方不能直接修改评分");
      return false;
    }
    if (item.judge !== judge.value) {
      log("越权操作被拒绝", `${judge.value} 试图修改 ${item.judge} 的评分（${schemeCode(item.schemeId)}）`);
      return false;
    }
    return true;
  }

  /** 申报利益冲突：已交评分是否继续算数需重新裁定；结论变化则名次作废重算 */
  function applyConflict(item: ScoreRecord, conflict: boolean) {
    const prev = item.recusal;
    item.conflict = conflict;
    // 草稿阶段仅记录申报，提交后才进入回避裁定流程
    if (!item.submitted) return;
    if (conflict) {
      if (prev === "none" || prev === "cleared") item.recusal = "pending";
    } else {
      if (prev === "pending") item.recusal = "none";
      else if (prev === "recused" || prev === "cleared") item.recusal = "pending";
    }
    if (prev !== item.recusal && (prev === "recused" || prev === "cleared")) {
      invalidateRanking("回避结论变化");
    }
    if (conflict && item.recusal === "pending") {
      log("回避申报", `${item.judge} ${schemeCode(item.schemeId)}，已交评分待重新裁定`);
    }
  }

  function saveDraft(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean) {
    const item = record(schemeId);
    if (!item) return { ok: false as const, reason: "无权限" as const };
    if (item.submitted) return { ok: false as const, reason: "已提交" as const };
    if (!assertOwns(item)) return { ok: false as const, reason: "越权" as const };
    applyConflict(item, conflict);
    item.values = { ...values };
    item.comment = comment;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme && scheme.status === "待评分") scheme.status = "评分中";
    log("保存评分草稿", `${schemeCode(schemeId)}${conflict ? "，声明利益冲突" : ""}`);
    return { ok: true as const };
  }

  function submit(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean) {
    const item = record(schemeId);
    if (!item) return { ok: false as const, reason: "无权限" as const };
    if (!assertOwns(item)) return { ok: false as const, reason: "越权" as const };

    // 主办方已确认后，同一评委从另一设备晚到的提交先停待复核区，不覆盖已确认状态
    if (item.confirmed) {
      pendingReviews.value.unshift({
        id: crypto.randomUUID(),
        judge: item.judge,
        schemeId,
        values: { ...values },
        comment,
        conflict,
        reason: "concurrent",
        arrivedAt: new Date().toISOString()
      });
      log("晚到提交停入待复核区", `${item.judge} ${schemeCode(schemeId)}，未覆盖已确认状态`);
      return { ok: true as const, parked: true as const };
    }

    item.submitted = true;
    applyConflict(item, conflict);
    item.values = { ...values };
    item.comment = comment;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme) scheme.status = allSubmittedFor(schemeId) ? "已提交" : "评分中";
    log("提交评分", schemeCode(schemeId));
    return { ok: true as const };
  }

  function recalled(schemeId: string) {
    const item = record(schemeId);
    if (!item || published.value) return { ok: false as const };
    if (!assertOwns(item)) return { ok: false as const, reason: "越权" as const };
    // 已确认的评分不得直接退回，修改一律走晚到提交待复核
    if (item.confirmed) return { ok: false as const, reason: "已确认" as const };
    item.submitted = false;
    log("退回评分修改", schemeCode(schemeId));
    return { ok: true as const };
  }

  /** 主办方确认某方案的提交状态；确认后晚到提交停待复核区 */
  function confirmScheme(schemeId: string) {
    const rows = scores.value.filter(
      (score) => score.schemeId === schemeId && score.submitted && !score.superseded
    );
    if (!rows.length) return;
    rows.forEach((score) => {
      score.confirmed = true;
    });
    log("确认提交状态", `${schemeCode(schemeId)}（${rows.length} 份评分）`);
  }

  /** 主办方回避裁定：recused 回避（评分不计入排名，原分留档核查）/ cleared 不回避（评分有效） */
  function adjudicateRecusal(scoreId: string, decision: "recused" | "cleared") {
    const item = scores.value.find((score) => score.id === scoreId);
    if (!item) return;
    const prev = item.recusal;
    item.recusal = decision;
    log(
      "回避裁定",
      `${item.judge} ${schemeCode(item.schemeId)} → ${decision === "recused" ? "回避，评分不计入排名（原分留档核查）" : "不回避，评分有效"}`
    );
    if (published.value && prev !== decision) invalidateRanking("回避结论变化");
  }

  /** 待复核区：采纳晚到提交（原确认版本留作核查）或驳回 */
  function reviewPending(pendingId: string, accept: boolean) {
    const idx = pendingReviews.value.findIndex((pending) => pending.id === pendingId);
    if (idx === -1) return;
    const pending = pendingReviews.value[idx];
    if (accept) {
      const current = scores.value.find(
        (score) => score.judge === pending.judge && score.schemeId === pending.schemeId && !score.superseded
      );
      if (current) {
        const audit: ScoreRecord = {
          ...current,
          id: `${current.id}-audit-${crypto.randomUUID()}`,
          superseded: true,
          confirmed: false
        };
        scores.value.push(audit);
        current.values = { ...pending.values };
        current.comment = pending.comment;
        current.conflict = pending.conflict;
        current.confirmed = true;
        current.recusal = pending.conflict ? "pending" : current.recusal;
        current.updatedAt = new Date().toISOString();
      }
      log("采纳待复核提交", `${pending.judge} ${schemeCode(pending.schemeId)}，原确认版本留作核查`);
    } else {
      log("驳回待复核提交", `${pending.judge} ${schemeCode(pending.schemeId)}`);
    }
    pendingReviews.value.splice(idx, 1);
  }

  /** 回避结论变化：有效评委数与名次作废重算，已发布结果撤回待重新锁定 */
  function invalidateRanking(reason: string) {
    if (!published.value) return;
    published.value = false;
    schemes.value.forEach((scheme) => {
      if (scheme.status === "已锁定") scheme.status = "已提交";
    });
    log("名次作废重算", reason);
  }

  function allSubmittedFor(schemeId: string) {
    return judges.every((name) =>
      scores.value.some(
        (score) => score.judge === name && score.schemeId === schemeId && score.submitted && !score.superseded
      )
    );
  }

  const pendingRecusalCount = computed(
    () => scores.value.filter((score) => !score.superseded && score.recusal === "pending").length
  );
  const pendingReviewCount = computed(() => pendingReviews.value.length);

  const ranking = computed(() => {
    if (!published.value) return [];
    return schemes.value.map((scheme) => {
      const rows = scores.value.filter(
        (score) =>
          score.schemeId === scheme.id &&
          score.submitted &&
          !score.superseded &&
          score.recusal !== "pending" &&
          score.recusal !== "recused"
      );
      const total = rows.length
        ? rows.reduce(
            (sum, row) =>
              sum + criteria.reduce((value, criterion) => value + (row.values[criterion.id] * criterion.weight) / 100, 0),
            0
          ) / rows.length
        : 0;
      return {
        ...scheme,
        total: Number(total.toFixed(2)),
        judgeCount: rows.length,
        conflicts: scores.value.filter(
          (score) => score.schemeId === scheme.id && !score.superseded && score.recusal === "recused"
        ).length
      };
    }).sort((a, b) => b.total - a.total);
  });

  function publish() {
    if (!schemes.value.every((scheme) => allSubmittedFor(scheme.id))) {
      return { ok: false as const, reason: "未齐备" as const };
    }
    // 所有裁定结束才能锁定：回避待裁定、待复核区均清空
    if (pendingRecusalCount.value > 0 || pendingReviewCount.value > 0) {
      return {
        ok: false as const,
        reason: "裁定未结束" as const,
        pendingRecusal: pendingRecusalCount.value,
        pendingReview: pendingReviewCount.value
      };
    }
    published.value = true;
    schemes.value.forEach((scheme) => {
      scheme.status = "已锁定";
    });
    log("锁定并发布结果", `${schemes.value.length} 个匿名方案`);
    return { ok: true as const };
  }

  function setViewer(value: Viewer) {
    viewer.value = value;
  }

  /** 演练：越权修改他人评分（应被直接拒绝，且草稿保留可重试） */
  function simulateOverstep(schemeId: string) {
    const other = judges.find((name) => name !== judge.value) ?? judges[0];
    const item =
      scores.value.find((score) => score.judge === other && score.schemeId === schemeId && !score.superseded) ??
      emptyScore(other, schemeId);
    if (!scores.value.includes(item)) scores.value.push(item);
    if (!assertOwns(item)) return { ok: false as const, reason: "越权" as const };
    return { ok: true as const };
  }

  watch(
    [scores, events, published, schemes, pendingReviews],
    () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          scores: scores.value,
          events: events.value,
          published: published.value,
          pendingReviews: pendingReviews.value,
          schemeStatuses: Object.fromEntries(schemes.value.map((scheme) => [scheme.id, scheme.status]))
        })
      );
    },
    { deep: true }
  );

  return {
    viewer,
    schemes,
    criteria,
    judges,
    scores,
    events,
    published,
    pendingReviews,
    ranking,
    visibleScores,
    isOrganizer,
    judge,
    pendingRecusalCount,
    pendingReviewCount,
    setViewer,
    record,
    saveDraft,
    submit,
    recalled,
    publish,
    allSubmittedFor,
    confirmScheme,
    adjudicateRecusal,
    reviewPending,
    invalidateRanking,
    simulateOverstep
  };
});
