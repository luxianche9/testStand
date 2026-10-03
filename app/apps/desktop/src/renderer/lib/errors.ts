import type { ErrorCategory } from "@teststand/contracts/errors";

const ERROR_CATEGORY_MESSAGES: Readonly<Partial<Record<ErrorCategory, string>>> = {
  permission_denied: "没有权限执行此操作",
  invalid_argument: "提交的参数无效",
  unavailable: "服务当前不可用，请稍后重试",
  conflict: "当前内容已发生变化，请刷新后重试",
  not_found: "请求的内容不存在",
  validation_failed: "内容校验未通过",
  requires_project: "请先打开一个工程",
  safe_stop_failed: "设备未能安全停止，请立即检查现场状态",
  invalid_response: "设备返回了无法识别的响应",
  loop_limit: "执行已达到循环次数上限",
  assertion_failed: "断言未通过",
  project_exists: "目标位置已经存在工程",
  invalid_project: "工程内容无效或已损坏",
  project_uninitialized: "该文件夹尚未初始化为工程",
  invalid_project_folder: "所选文件夹不能用作工程目录",
  cancelled: "操作已取消"
};

export function errorCategoryMessage(category: string): string | undefined {
  return ERROR_CATEGORY_MESSAGES[category as ErrorCategory];
}

export function errorMessage(value: unknown): string {
  const candidate = value as { category?: unknown } | null | undefined;
  if (typeof candidate?.category === "string") {
    const mapped = ERROR_CATEGORY_MESSAGES[candidate.category as ErrorCategory];
    if (mapped) return mapped;
  }
  return value instanceof Error ? value.message : String(value);
}
