import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import type {
  Criterion, DeviceId, OutboxItem, ReviewEvent, ReviewItem, ReviewStatus,
  Scheme, ScoreRecord, ScoreSnapshot, ScoreVersion, Viewer
} from "../types";

const KEY = "pair-wise-yf-48/review/v2";
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
    id: `${judge}-${schemeId}`, judge, schemeId,
    values: Object.fromEntries(criteria.map((item) => [item.id, 60])),
    comment: "", submitted: false, conflict: false,
    updatedAt: new Date().toISOString(), deviceId: "设备A", history: []
  };
}

function cloneSnapshot(record: ScoreRecord): ScoreSnapshot & { deviceId: DeviceId } {
  return { values: { ...record.values }, comment: record.comment, deviceId: record.deviceId };
}

export const useReviewStore = defineStore("review", () => {
  const saved = localStorage.getItem(KEY);
  const initial = saved
    ? JSON.parse(saved)
    : { scores: [], events: [], published: false, schemeStatuses: {}, reviews: [], outbox: [], rankEpoch: 0, lastRankedAt: null, networkOn: true };

  const viewer = ref<Viewer>("评委-林策");
  const schemes = ref<Scheme[]>(seedSchemes.map((scheme) => ({ ...scheme, status: initial.schemeStatuses?.[scheme.id] ?? scheme.status })));
  const scores = ref<ScoreRecord[]>(initial.scores ?? []);
  const events = ref<ReviewEvent[]>(initial.events ?? []);
  const published = ref<boolean>(initial.published ?? false);
  /** 回避申报与晚到提交的待复核队列（含已定结论，便于主办方改判） */
  const reviews = ref<ReviewItem[]>(initial.reviews ?? []);
  /** 保存失败后留住的申报与草稿，待网络恢复重试 */
  const outbox = ref<OutboxItem[]>(initial.outbox ?? []);
  /** 名次作废重算的版本号，每次有效裁定集合变化都 +1 */
  const rankEpoch = ref<number>(initial.rankEpoch ?? 0);
  const lastRankedAt = ref<string | null>(initial.lastRankedAt ?? null);
  /** 演示用网络开关：关闭后提交/保存进入本地待重发 */
  const networkOn = ref<boolean>(initial.networkOn ?? true);

  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed(() => viewer.value.startsWith("评委-") ? viewer.value : null);
  const visibleScores = computed(() => isOrganizer.value ? scores.value : scores.value.filter((score) => score.judge === judge.value));
  const pendingReviews = computed(() => reviews.value.filter((item) => item.status === "待复核"));
  const openOutbox = computed(() => outbox.value);

  function log(action: string, detail: string, actor: Viewer = viewer.value) {
    events.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
  }

  function bumpRank(reason: string) {
    rankEpoch.value += 1;
    lastRankedAt.value = new Date().toISOString();
    log("名次作废重算", `${reason}（第 ${rankEpoch.value} 版）`);
  }

  function record(schemeId: string, actor: Viewer = viewer.value) {
    if (!actor.startsWith("评委-")) return null;
    let item = scores.value.find((score) => score.judge === actor && score.schemeId === schemeId);
    if (!item) {
      item = emptyScore(actor, schemeId);
      scores.value.push(item);
    }
    return item;
  }

  /** 评委本人对该方案是否存在待复核事项（待复核期间不能退回、不能改分） */
  function hasOpenReview(schemeId: string, judgeName: Viewer) {
    return reviews.value.some((item) => item.judge === judgeName && item.schemeId === schemeId && item.status === "待复核");
  }

  /**
   * 已提交且有效：
   * - 回避申报待裁定或裁定不计分：原分留档但暂不/不再参加排名；
   * - 重复提交待复核：晚到副本停在复核区，主办方已确认的原状态继续有效。
   */
  function isEffective(score: ScoreRecord) {
    if (!score.submitted) return false;
    return !reviews.value.some((item) => {
      if (item.judge !== score.judge || item.schemeId !== score.schemeId) return false;
      if (item.status === "不计分") return true;
      return item.status === "待复核" && item.kind === "回避申报";
    });
  }

  /** 锁定前用于门槛判断：有效提交（已裁定回避成立的评分可豁免提交齐备要求） */
  function effectiveJudgeCount(schemeId: string) {
    return judges.filter((name) => scores.value.some((score) => score.judge === name && score.schemeId === schemeId && isEffective(score))).length;
  }

  // ---------- 评委操作 ----------

  function saveDraft(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean, deviceId: DeviceId = "设备A", actor: Viewer = viewer.value): boolean {
    const item = record(schemeId, actor);
    if (!item || item.submitted || hasOpenReview(schemeId, item.judge)) return false;
    if (!networkOn.value) {
      outbox.value.unshift({ id: crypto.randomUUID(), type: "草稿", judge: actor, schemeId, deviceId, values: { ...values }, comment, conflict, attempts: 1, at: new Date().toISOString() });
      log("保存失败已留存", `${schemes.value.find((s) => s.id === schemeId)?.code ?? schemeId} 的草稿保留在本机，可重试`, actor);
      return false;
    }
    item.values = { ...values };
    item.comment = comment;
    item.conflict = conflict;
    item.deviceId = deviceId;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme && scheme.status === "待评分") scheme.status = "评分中";
    log("保存评分草稿", `${scheme?.code ?? schemeId}（${deviceId}）${conflict ? "，声明利益冲突" : ""}`, actor);
    return true;
  }

  function pushVersion(item: ScoreRecord, via: string) {
    const version: ScoreVersion = { at: new Date().toISOString(), via, values: { ...item.values }, comment: item.comment };
    item.history.push(version);
  }

  /**
   * 提交评分。
   * 同一评委从不同设备再次提交时，晚到那份停在待复核区，不覆盖主办方刚确认的状态。
   */
  function submit(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean, deviceId: DeviceId = "设备A", actor: Viewer = viewer.value): "ok" | "blocked" | "parked" | "offline" {
    const item = record(schemeId, actor);
    if (!item || hasOpenReview(schemeId, item.judge)) return "blocked";
    if (!networkOn.value) {
      const queued: OutboxItem = { id: crypto.randomUUID(), type: "提交", judge: actor, schemeId, deviceId, values: { ...values }, comment, conflict, attempts: 1, at: new Date().toISOString() };
      outbox.value.unshift(queued);
      log("保存失败已留存", `${schemes.value.find((s) => s.id === schemeId)?.code ?? schemeId} 的提交保留在本机，可重试`, actor);
      return "offline";
    }

    if (item.submitted && item.deviceId !== deviceId) {
      const duplicate: ReviewItem = {
        id: crypto.randomUUID(), kind: "重复提交", judge: item.judge, schemeId, deviceId,
        status: "待复核", createdAt: new Date().toISOString(),
        snapshot: { values: { ...values }, comment },
        baseSnapshot: cloneSnapshot(item)
      };
      reviews.value.push(duplicate);
      log("双设备并发提交", `${item.judge} 在 ${schemes.value.find((s) => s.id === schemeId)?.code ?? schemeId} 的 ${deviceId} 晚到，已停入待复核区，原确认状态保留`, actor);
      bumpRank("出现待复核的晚到评分");
      return "parked";
    }

    item.values = { ...values };
    item.comment = comment;
    item.conflict = conflict;
    item.deviceId = deviceId;
    item.submitted = true;
    item.updatedAt = new Date().toISOString();
    pushVersion(item, `${deviceId}正式提交`);
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme) scheme.status = allSubmittedFor(schemeId) ? "已提交" : "评分中";
    log("提交评分", `${scheme?.code ?? schemeId}（${deviceId}）`, actor);
    return "ok";
  }

  /** 锁定前提出回避：已交评分是否算数交主办方重新裁定，原分与评语留作核查依据 */
  function declareRecusal(schemeId: string, reason: string, deviceId: DeviceId = "设备A", actor: Viewer = viewer.value): "ok" | "blocked" | "offline" {
    const item = record(schemeId, actor);
    if (!item) return "blocked";
    if (!reason.trim()) return "blocked";
    if (hasOpenReview(schemeId, item.judge)) return "blocked";
    if (!networkOn.value) {
      const queued: OutboxItem = { id: crypto.randomUUID(), type: "回避申报", judge: actor, schemeId, deviceId, values: { ...item.values }, comment: item.comment, conflict: item.conflict, reason, attempts: 1, at: new Date().toISOString() };
      outbox.value.unshift(queued);
      log("保存失败已留存", `${schemes.value.find((s) => s.id === schemeId)?.code ?? schemeId} 的回避申报保留在本机，可重试`, actor);
      return "offline";
    }
    const review: ReviewItem = {
      id: crypto.randomUUID(), kind: "回避申报", judge: item.judge, schemeId, deviceId,
      status: "待复核", createdAt: new Date().toISOString(), reason
    };
    reviews.value.push(review);
    log("提出回避申报", `${item.judge} 就 ${schemes.value.find((s) => s.id === schemeId)?.code ?? schemeId} 申报回避：${reason}；原分与评语已留档，计分资格待裁定`, actor);
    bumpRank("收到回避申报，相关评分暂不计入");
    return "ok";
  }

  function recalled(schemeId: string) {
    const item = record(schemeId);
    if (!item || published.value) return;
    if (hasOpenReview(schemeId, item.judge)) {
      log("退回被拦", `${schemes.value.find((s) => s.id === schemeId)?.code ?? schemeId} 存在待复核裁定，不能退回`);
      return;
    }
    item.submitted = false;
    log("退回评分修改", schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId);
  }

  function allSubmittedFor(schemeId: string) {
    return judges.every((name) => scores.value.some((score) => score.judge === name && score.schemeId === schemeId && score.submitted));
  }

  // ---------- 越权防护 ----------

  /** 越权改他人评分：直接拒绝，不落任何变更，只留审计事件 */
  function attemptUnauthorizedEdit(targetJudge: Viewer, schemeId: string): boolean {
    if (viewer.value === targetJudge) return false;
    log("越权修改被拒绝", `${viewer.value} 试图改动 ${targetJudge} 在 ${schemes.value.find((s) => s.id === schemeId)?.code ?? schemeId} 的评分，请求已直接拒绝`);
    return true;
  }

  // ---------- 主办方裁定 ----------

  /**
   * 裁定回避申报 / 晚到提交。
   * 结论变化即令有效评委数与名次作废重算；已结项可再次改判。
   */
  function decideReview(reviewId: string, status: Exclude<ReviewStatus, "待复核">): boolean {
    if (!isOrganizer.value) {
      log("越权修改被拒绝", `${viewer.value} 试图代行裁定，请求已直接拒绝`);
      return false;
    }
    const item = reviews.value.find((entry) => entry.id === reviewId);
    if (!item) return false;
    const previous = item.status;
    const score = scores.value.find((entry) => entry.judge === item.judge && entry.schemeId === item.schemeId);
    const code = schemes.value.find((s) => s.id === item.schemeId)?.code ?? item.schemeId;

    if (item.kind === "重复提交" && score?.submitted && item.snapshot && item.baseSnapshot) {
      if (status === "采纳") {
        score.values = { ...item.snapshot.values };
        score.comment = item.snapshot.comment;
        score.deviceId = item.deviceId;
        score.updatedAt = new Date().toISOString();
        pushVersion(score, `主办方采纳${item.deviceId}晚到提交`);
      } else if (status === "驳回") {
        score.values = { ...item.baseSnapshot.values };
        score.comment = item.baseSnapshot.comment;
        score.deviceId = item.baseSnapshot.deviceId;
        score.updatedAt = new Date().toISOString();
        pushVersion(score, "主办方驳回晚到提交，还原已确认版本");
      }
    }

    item.status = status;
    item.decidedAt = new Date().toISOString();
    const label = item.kind === "回避申报"
      ? (status === "计分" ? "回避不成立，评分继续计分" : "回避成立，评分不计入排名")
      : (status === "采纳" ? `采纳${item.deviceId}晚到提交` : "驳回晚到提交，维持已确认状态");
    log("回避/复核裁定", `${code} · ${item.judge}：${previous} → ${status}（${label}）；原分与评语继续留档核查`);
    bumpRank(`裁定结论变化：${code} · ${item.judge} ${status}`);
    return true;
  }

  // ---------- 待重发 ----------

  /** 网络恢复后重试留住的草稿与申报；仍失败的继续留下（全程以申报人本人身份执行，不借用当前登录身份） */
  function flushOutbox(): number {
    if (!networkOn.value || !outbox.value.length) return 0;
    let done = 0;
    for (const queued of [...outbox.value]) {
      if (!networkOn.value) break;
      let ok = false;
      if (queued.type === "草稿") {
        ok = saveDraft(queued.schemeId, queued.values, queued.comment, queued.conflict, queued.deviceId, queued.judge);
      } else if (queued.type === "提交") {
        ok = submit(queued.schemeId, queued.values, queued.comment, queued.conflict, queued.deviceId, queued.judge) !== "offline";
      } else {
        ok = declareRecusal(queued.schemeId, queued.reason ?? "", queued.deviceId, queued.judge) !== "offline";
      }
      if (ok) {
        outbox.value = outbox.value.filter((entry) => entry.id !== queued.id);
        log("重试成功", `${queued.judge} 的${queued.type}已补发到 ${schemes.value.find((s) => s.id === queued.schemeId)?.code ?? queued.schemeId}`, queued.judge);
        done += 1;
      } else {
        queued.attempts += 1;
      }
    }
    return done;
  }

  // ---------- 排名与锁定 ----------

  const ranking = computed(() => {
    if (!published.value) return [];
    return schemes.value.map((scheme) => {
      const rows = scores.value.filter((score) => score.schemeId === scheme.id && isEffective(score));
      const total = rows.length
        ? rows.reduce((sum, row) => sum + criteria.reduce((value, criterion) => value + row.values[criterion.id] * criterion.weight / 100, 0), 0) / rows.length
        : 0;
      return {
        ...scheme,
        total: Number(total.toFixed(2)),
        judgeCount: rows.length,
        pending: reviews.value.filter((r) => r.schemeId === scheme.id && r.status === "待复核").length,
        conflicts: reviews.value.filter((r) => r.schemeId === scheme.id && r.status === "不计分").length
      };
    }).sort((a, b) => b.total - a.total);
  });

  const lockBlockers = computed(() => {
    const blockers: string[] = [];
    if (pendingReviews.value.length) blockers.push(`仍有 ${pendingReviews.value.length} 项回避/复核裁定未结束`);
    if (outbox.value.length) blockers.push(`仍有 ${outbox.value.length} 份保存失败的草稿或申报未重试成功`);
    const incomplete = schemes.value.filter((scheme) =>
      judges.some((name) => {
        const score = scores.value.find((s) => s.judge === name && s.schemeId === scheme.id);
        const exempt = reviews.value.some((r) =>
          r.judge === name && r.schemeId === scheme.id && r.kind === "回避申报" &&
          (r.status === "待复核" || r.status === "不计分"));
        return (!score || !isEffective(score)) && !exempt;
      })
    );
    if (incomplete.length) blockers.push(`仍有方案未完成提交：${incomplete.map((s) => s.code).join("、")}`);
    return blockers;
  });

  /** 所有裁定结束、待重发清空、提交齐备后才能锁定 */
  function publish(): boolean {
    if (published.value || lockBlockers.value.length) return false;
    published.value = true;
    rankEpoch.value += 1;
    lastRankedAt.value = new Date().toISOString();
    schemes.value.forEach((scheme) => { scheme.status = "已锁定"; });
    log("锁定并发布结果", `${schemes.value.length} 个匿名方案，全部裁定已结束，按第 ${rankEpoch.value} 版名次锁定`);
    return true;
  }

  function setViewer(value: Viewer) { viewer.value = value; }
  function setNetwork(on: boolean) {
    networkOn.value = on;
    log(on ? "网络恢复" : "网络中断演练", on ? "可以重试留住的草稿与申报" : "此后保存将留在本机待重发");
  }

  watch([scores, events, published, schemes, reviews, outbox, rankEpoch, networkOn], () => {
    localStorage.setItem(KEY, JSON.stringify({
      scores: scores.value, events: events.value, published: published.value,
      schemeStatuses: Object.fromEntries(schemes.value.map((scheme) => [scheme.id, scheme.status])),
      reviews: reviews.value, outbox: outbox.value, rankEpoch: rankEpoch.value,
      lastRankedAt: lastRankedAt.value, networkOn: networkOn.value
    }));
  }, { deep: true });

  return {
    viewer, schemes, criteria, judges, scores, events, published, reviews, outbox, rankEpoch, lastRankedAt, networkOn,
    ranking, visibleScores, isOrganizer, judge, pendingReviews, openOutbox, lockBlockers,
    setViewer, setNetwork, record, hasOpenReview, isEffective, effectiveJudgeCount,
    saveDraft, submit, declareRecusal, recalled, allSubmittedFor, attemptUnauthorizedEdit,
    decideReview, flushOutbox, publish
  };
});
