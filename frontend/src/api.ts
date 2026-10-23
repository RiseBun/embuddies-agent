import type { Json } from "./types";
export async function request(
  path: string,
  body?: Json,
  onEvent?: (event: Json) => void,
): Promise<Json> {
  if (!window.EMBUDDIES_DESKTOP)
    throw new Error("请从 embuddies 桌面应用打开工作台");
  const result = await window.EMBUDDIES_DESKTOP.request(
    { method: body ? "POST" : "GET", path, body },
    onEvent,
  );
  if (result.ok === false) throw new Error(result.error || "操作未完成");
  return result;
}
export const host = (method: string, values: any[] = []) =>
  window.EMBUDDIES_DESKTOP?.invoke(method, values) ||
  Promise.reject(new Error("桌面宿主不可用"));
export function downloadJson(name: string, value: Json) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
