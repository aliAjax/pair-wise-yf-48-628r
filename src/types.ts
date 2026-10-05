export type Viewer = "评委-林策" | "评委-周筑" | "主办方";
export type SchemeStatus = "待评分" | "评分中" | "已提交" | "已锁定";
export type DeviceId = "设备A" | "设备B";

/** 复核事项种类：评委回避申报 / 双设备晚到提交 */
export type ReviewKind = "回避申报" | "重复提交";
/** 待复核；回避裁定：计分 / 不计分；重复提交裁定：采纳晚到 / 驳回晚到 */
export type ReviewStatus = "待复核" | "计分" | "不计分" | "采纳" | "驳回";
/** 本地待重发的操作类型（保存失败后留住） */
export type OutboxType = "草稿" | "提交" | "回避申报";

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

/** 每次正式提交形成的留档版本，原分与评语永远保留作核查依据 */
export interface ScoreVersion {
  at: string;
  via: string;
  values: Record<string, number>;
  comment: string;
}

export interface ScoreRecord {
  id: string;
  judge: Viewer;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  submitted: boolean;
  /** 评委自行声明利益冲突；是否计分以主办方最新裁定为准 */
  conflict: boolean;
  updatedAt: string;
  deviceId: DeviceId;
  history: ScoreVersion[];
}

export interface ScoreSnapshot {
  values: Record<string, number>;
  comment: string;
}

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  judge: Viewer;
  schemeId: string;
  /** 晚到提交来源设备；回避申报为申报人当时设备 */
  deviceId: DeviceId;
  status: ReviewStatus;
  createdAt: string;
  decidedAt?: string;
  /** 回避理由（与评分正文分开，锁定前不暴露评语） */
  reason?: string;
  /** 重复提交：晚到设备携带的副本，停在待复核区等待裁定 */
  snapshot?: ScoreSnapshot;
  /** 重复提交：被保护的已确认状态，改判“驳回”时据此还原 */
  baseSnapshot?: ScoreSnapshot & { deviceId: DeviceId };
}

/** 保存失败时留住的草稿 / 申报，网络恢复后可原样重试 */
export interface OutboxItem {
  id: string;
  type: OutboxType;
  judge: Viewer;
  schemeId: string;
  deviceId: DeviceId;
  values: Record<string, number>;
  comment: string;
  conflict: boolean;
  reason?: string;
  attempts: number;
  at: string;
}

export interface ReviewEvent {
  id: string;
  time: string;
  actor: Viewer;
  action: string;
  detail: string;
}
