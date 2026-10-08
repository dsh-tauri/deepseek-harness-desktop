/**
 * 服务生命周期与健康检查的时序常量（毫秒）。
 *
 * 集中一处：启动/插件安装/页面加载各自有「无活动」与「绝对」双上限，
 * 调参时需要在同一屏内对照，散落在 actions 之间极易改漏。
 */

/** iframe 挂载后等待 dsh 页面完成加载的兜底上限 */
export const IFRAME_LOAD_TIMEOUT = 20000

/**
 * iframe 已触发 load、但帧内迟迟没有确认承载 dsh 文档时的宽限上限。
 *
 * 浏览器内部错误页（图省事的代理拦截、DNS 失败等）同样会触发 iframe 的 load，
 * 而这类页面永远不会给出帧内消息（issue #705）。帧已提交后再等整个加载上限，
 * 只会让用户多盯 20 秒的浏览器错误页，因此这里用一个远小于它的窗口尽快转为
 * 可重试界面。必须大于插件 boot 桥的轮询间隔（1s），留出首次帧身份申报的时间。
 */
export const IFRAME_FRAME_GRACE_TIMEOUT = 5000

/**
 * 服务就绪探测间隔。
 *
 * 固定 1s，不退避：端口起来后一轮探测约 0.3-0.5s，退避却会让「服务已就绪」最多
 * 晚 5s 才被发现，而这正是启动尾段的全部剩余时间；探测几乎零成本的轮次改用
 * HEALTH_PROBE_FAST_RETRY_INTERVAL。
 */
export const HEALTH_PROBE_INTERVAL = 1000

/**
 * 探测几乎零成本时的快扫间隔（端口未监听 / 启动页尚未登记）。
 *
 * 这两种状态都由 Rust 侧在取任何 bundle 之前判定，单轮探测不足 5ms（端口门禁只做
 * 一次 bind，启动页未登记只发一次请求），于是用快扫去撞状态结束的那一刻：常规 1s
 * 间隔下平均还要空等 ~0.5s 才会被下一次探测发现，实测这段空等正好压在启动尾段
 * （boot page 404 之后白等满 1s 才重试）。其余失败仍走 1s：那些轮次已经拉了约
 * 18MB 的 bundle，加快节奏只会和页面加载抢带宽。
 */
export const HEALTH_PROBE_FAST_RETRY_INTERVAL = 250

/** 服务启动阶段：无活动 / 绝对上限 */
export const STARTUP_INACTIVITY_TIMEOUT = 180000
export const STARTUP_ABSOLUTE_TIMEOUT = 300000

/** 内置插件自愈阶段：无活动 / 绝对上限 */
export const PLUGIN_INACTIVITY_TIMEOUT = 30000
export const PLUGIN_ABSOLUTE_TIMEOUT = 600000
export const PLUGIN_ACTIVITY_CHECK_INTERVAL = 1000

/** iframe 内官方 boot 页失败后的恢复探测上限（远小于完整启动） */
export const IFRAME_RECOVERY_ABSOLUTE_TIMEOUT = 60000

/** 启动失败时从服务日志尾部挑选的原始行上限（ANSI 清洗后按行截断） */
export const LOG_TAIL_MAX_BYTES = 16 * 1024

/** 进入 ready 后 iframe 连续重载的容忍次数（防抖 + 防死循环） */
export const IFRAME_RELOAD_MAX_ATTEMPTS = 3
