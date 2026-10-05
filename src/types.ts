export type Viewer = "评委-林策" | "评委-周筑" | "主办方";
export type SchemeStatus = "待评分" | "评分中" | "已提交" | "已锁定";

/** 回避裁定结论：none 未申报 / pending 待裁定 / recused 回避（评分不计）/ cleared 不回避（评分有效） */
export type RecusalState = "none" | "pending" | "recused" | "cleared";

/** 待复核区来源：concurrent 同一评委另一设备晚到 / recusal 回避申报待裁定 */
export type PendingReason = "concurrent" | "recusal";

export interface Scheme {
  id: string;
  code: string;
  title: string;
  synopsis: string;
  publicNo: string;
  status: SchemeStatus;
}

export interface Criterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  max: number;
}

export interface ScoreRecord {
  id: string;
  judge: Viewer;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  submitted: boolean;
  /** 评委申报利益冲突 */
  conflict: boolean;
  /** 主办方回避裁定结论 */
  recusal: RecusalState;
  /** 主办方已确认提交状态；确认后晚到提交停待复核区，不得覆盖 */
  confirmed: boolean;
  /** 被更新版本替代，仅留作核查依据，不再参与计数 */
  superseded: boolean;
  updatedAt: string;
}

/** 待复核区条目：晚到的设备提交，或需重新裁定的回避申报 */
export interface PendingReview {
  id: string;
  judge: Viewer;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  conflict: boolean;
  reason: PendingReason;
  arrivedAt: string;
}

export interface ReviewEvent {
  id: string;
  time: string;
  actor: Viewer;
  action: string;
  detail: string;
}
