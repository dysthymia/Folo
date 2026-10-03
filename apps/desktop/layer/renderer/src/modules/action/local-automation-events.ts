// 生效事件只刷新已发布镜像，不把编辑草稿提前交给阅读页执行。
export const localAutomationChanged = "folo:local-automation-published"
export const notifyLocalAutomationChanged = () =>
  window.dispatchEvent(new Event(localAutomationChanged))
