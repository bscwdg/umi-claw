import { ref } from "vue";

export type ToastType = "success" | "error";

export interface ToastState {
  msg: string;
  type: ToastType;
}

/**
 * 轻量级 Toast 提示 composable，统一各页面的提示逻辑。
 * @param duration 自动消失时间（毫秒），默认 2500
 */
export function useToast(duration = 2500) {
  const toast = ref<ToastState | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function showToast(msg: string, type: ToastType) {
    if (timer) clearTimeout(timer);
    toast.value = { msg, type };
    timer = setTimeout(() => {
      toast.value = null;
      timer = null;
    }, duration);
  }

  return { toast, showToast };
}
