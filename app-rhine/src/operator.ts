// 操作员 ID：开屏「ID CONFIRMED」、页脚、访问日志与设置页里的 "JOYCE MOORE" 现在可自定义。
const KEY = "rhine-operator";
const DEFAULT = "JOYCE MOORE";

export function getOperator(): string {
  try {
    const value = localStorage.getItem(KEY);
    if (value && value.trim()) return value.trim().slice(0, 40);
  } catch {
    /* localStorage 不可用时退回默认 */
  }
  return DEFAULT;
}

export function setOperator(name: string): string {
  const value = (name || "").trim().slice(0, 40) || DEFAULT;
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* ignore */
  }
  return value;
}
