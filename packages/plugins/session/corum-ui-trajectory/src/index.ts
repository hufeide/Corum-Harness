/**
 * fork（corum）：@corum/corum-ui-trajectory 的 host 半——与官方一致：纯浏览器
 * 插件（轨迹视图无 host 侧行为），空 apply 让插件在 host cordis.yml / Loader 中
 * 可见；浏览器半经 package.json 的 dsh.client 声明由 exports["./client"] 发现。
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
