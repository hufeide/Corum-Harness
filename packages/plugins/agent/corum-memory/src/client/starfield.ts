/**
 * `useStarfield` —— 原生 WebGL2 记忆星云渲染器（**零依赖**，shader 是内联字符串）。
 *
 * ## 为什么手写 WebGL 而不是 three.js
 *
 * 用户选定「原生 WebGL shader」。前置风险已实测排除：Electron 里 WebGL2 可用
 * （`ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max)`，shader 编译链接通过）。
 * three.js 会往 client bundle 里加约 700 KB（插件 client bundle 把所有非 external
 * 依赖打进产物），而本渲染器几何只有四边形 + 点 ⇒ **零新依赖**。
 *
 * ## 关键选型：光点用 **billboard 方片**，不用 `gl_PointSize`
 *
 * 首版用 `gl.POINTS` + `gl_PointSize`，用户实测反馈两点：**放大后太糊**、**推不动了**。
 * 查证后确认这是 `gl_PointSize` 的**已知局限**（见
 * [webgl2fundamentals: working around gl_PointSize limitations](https://webgl2fundamentals.org/webgl/lessons/webgl-qna-working-around-gl_pointsize-limitations-webgl.html)）：
 *   1. 尺寸被硬件上限钳制（本机 `ALIASED_POINT_SIZE_RANGE` = [1, 511]，但**实际可用
 *      的清晰范围远小于此**）；越接近上限越糊；
 *   2. 点精灵在驱动里常被实现为**低精度路径**（无 mipmap / 无各向异性），放大即糊。
 *
 * 该文给出的标准解法是「**自建点系统：unit quad + 在着色器里按需展开**」——本文件照此
 * 实现：每个光点是一个 **camera-facing 四边形**，尺寸在**世界空间**里给定，投影后按像素
 * 算半径，片元里用解析式画圆（无需纹理）。这样：
 *   · **不糊**：尺寸由几何决定，不受 `gl_PointSize` 钳制与低精度路径影响；
 *   · **能一直放大**：世界尺寸随距离自然变大，没有「到顶就停」。
 *
 * ⚠️ **必须用实例化绘制（`drawArraysInstanced` + `vertexAttribDivisor`）**。
 * 该文示例把每个点的位置**重复 N 遍**来对齐顶点数（非实例化的老写法）。实测踩坑：
 * 若只重复「角点」而 center/color/radius 每点只给一份，`drawArrays` 会按**统一顶点数**
 * 读所有属性数组 ⇒ 越界 ⇒ `GL_INVALID_OPERATION(1282)` 且**整片全黑**（实测截图确认）。
 * WebGL2 原生支持实例化，故：单位方片 6 顶点走 divisor=0，其余属性每点一份走 divisor=1
 * —— 内存是 1× 而不是 6×，且语义正确。
 *
 * ## 视觉（对齐用户 2026-09-21 口径）
 *
 * - **层 = 球壳**（有厚度），`permanent` 层是**中心实心球**（「核心 = 永不忘记的」）；
 * - 每个光点**独立闪烁**（相位来自 id 哈希）+ **绕 Y 轴公转**（内快外慢，像行星系）；
 * - 加法混合 + 无深度写 ⇒ 光点自然叠加发光；
 * - 片元用「锐利核心 + 淡晕」的径向衰减，避免密集时糊成白团。
 *
 * ## 坐标系与镜头
 *
 * 坐标系放大到最外壳半径 3.00（层间距宽松）；相机距离范围 [0.18, 26] —— **可以推进到
 * 穿过中心球内部**，也能拉到很远看整团星云。滚轮/按钮用**乘性缩放**（远距离每档走得
 * 多、近距离走得少），手感一致且「一直能推」。
 *
 * ## 帧循环纪律
 *
 * 有闪烁与自转就必须**每帧重绘**：`preserveDrawingBuffer` 默认 false ⇒ 合成后缓冲被清，
 * 只画一帧就停会让画布变透明（实测表现为「整片全黑，但 GL 状态全正常」，极难排查）。
 * 停帧只在**滚出视口 / 标签页隐藏**时做（IntersectionObserver + `visibilitychange`）——
 * 这是设置面板，不该在后台持续烧 GPU。`dirty` 标记保留，但语义是「恢复可见时唤醒一次」，
 * **不是**每帧闸门。
 *
 * @module @corum/corum-memory/client/starfield
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { RING_STYLE, positionAt } from './star-points.ts'
import type { StarPoint } from './star-points.ts'

// 重导出：调用方（MemorySpace）只 import 一个模块即可。
export { RING_STYLE, toStarPoints, positionAt } from './star-points.ts'
export type { StarPoint } from './star-points.ts'

/**
 * 相机距离范围。
 * MIN 0.18：足以穿过中心永久球内部（球半径 0.34）⇒「可以一直放大」。
 * MAX 26：足以把整团星云收成一个小光团。
 */
export const MIN_DIST = 0.18
export const MAX_DIST = 26
/** 默认机位：略高于赤道、稍偏一侧，能同时看出球壳层次与厚度。 */
const DEFAULT_DIST = 9.2
const DEFAULT_YAW = 0.62
const DEFAULT_PITCH = 0.40
/** 视场角（弧度）。拾取（CPU）与渲染（GPU）共用。 */
const FOV = 0.9

/**
 * 顶点着色器：**单位四边形展开成 billboard**。
 *
 * 每个顶点带 `a_center`（世界中心）、`a_corner`（单位方片角点 ∈ {-0.5, +0.5}²）、
 * `a_radius`（世界半径）。展开用视图矩阵的 x/y 基向量 ⇒ 方片始终面向相机。
 */
const VS = `#version 300 es
in vec3 a_center;
in vec2 a_corner;
in vec4 a_color;
in float a_radius;   // 世界空间半径
in float a_phase;    // 闪烁相位
uniform mat4 u_proj;
uniform mat4 u_view;
uniform float u_time;
uniform float u_pulse;   // 全局脉动（整团呼吸；1.0 = 无）
out vec2 v_corner;
out vec4 v_color;
void main() {
  // 相机在世界空间的 right/up 基向量 = 视图矩阵的第一行、第二行。
  // 为什么不是 m[0] / m[1]：GLSL 里 mat4 的 m[0] 取的是第 0 列，而相机的 right
  // 方向在列主序矩阵里位于第 0 列的第 0/1/2 个元素之外——它是「行的转置」。
  // 首版写成 u_view[0].xyz（第 0 列），方片就沿错误轴展开，实测表现为星点被拉成
  // 斜向条纹而不是圆点。这里显式取「行」的三个分量，语义无歧义。
  vec3 xAxis = vec3(u_view[0][0], u_view[1][0], u_view[2][0]);
  vec3 yAxis = vec3(u_view[0][1], u_view[1][1], u_view[2][1]);
  vec3 world = a_center + (xAxis * a_corner.x + yAxis * a_corner.y) * a_radius * 2.0 * u_pulse;
  gl_Position = u_proj * u_view * vec4(world, 1.0);
  // 闪烁：每点自己的相位，0.62~1.0 呼吸（不取满，否则密集时像噪声）
  float twinkle = 0.62 + 0.38 * (0.5 + 0.5 * sin(u_time * 1.9 + a_phase));
  v_corner = a_corner;
  v_color = vec4(a_color.rgb, a_color.a * twinkle);
}`

/**
 * 片元着色器：解析式圆形光点（锐利核心 + 淡晕），**不用纹理**。
 *
 * 亮度上限 1.0 —— 首版给到 `0.55 + core*1.6` 且点尺寸上限 220px，密集时糊成白团
 * （用户实测确认）。现用 `pow(1-r, 3.2)` 的陡衰减：核心锐利、外圈只留很淡的晕。
 */
const FS = `#version 300 es
precision mediump float;
in vec2 v_corner;
in vec4 v_color;
out vec4 outColor;
void main() {
  float r = length(v_corner) * 2.0;   // 0 = 中心, 1 = 方片内切圆边缘
  if (r > 1.0) discard;
  float core = pow(1.0 - r, 3.2);
  float halo = pow(1.0 - r, 1.35) * 0.20;
  float a = clamp(core + halo, 0.0, 1.0) * v_color.a;
  vec3 rgb = mix(v_color.rgb, vec3(1.0), core * 0.28);
  // 预乘 alpha：rgb 必须先乘上 alpha，否则加法混合下颜色会偏亮/错位
  outColor = vec4(rgb * a, a);
}`

/** 极简 4x4 矩阵（列主序）。 */
function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ])
}

/**
 * 视图矩阵 = `T(0,0,-dist) · R(pitch,yaw) · T(-target)`。
 *
 * `target` 是**相机注视点**：把它设成某个光点的位置，该点就被移到画面正中
 * （用户口径「拉近到这个光点使其居中」）。首版没有 target、只靠 yaw/pitch 对准，
 * 那只能让点落到视野里、**无法真正居中**（球心始终在画面中心）。
 *
 * @param dist - 相机到注视点的距离。
 * @param yaw - 绕 Y 旋转。
 * @param pitch - 绕 X 旋转。
 * @param tx - 注视点 x。
 * @param ty - 注视点 y。
 * @param tz - 注视点 z。
 * @returns 列主序 4x4 视图矩阵。
 */
function viewMatrix(dist: number, yaw: number, pitch: number, tx: number, ty: number, tz: number): Float32Array {
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  const cp = Math.cos(pitch), sp = Math.sin(pitch)
  const r00 = cy, r01 = 0, r02 = -sy
  const r10 = sp * sy, r11 = cp, r12 = sp * cy
  const r20 = cp * sy, r21 = -sp, r22 = cp * cy
  // 平移分量 = R · (-target)；目标在原点时退化为 (0,0,-dist)，与旧实现一致。
  const ex = -(r00 * tx + r01 * ty + r02 * tz)
  const ey = -(r10 * tx + r11 * ty + r12 * tz)
  const ez = -(r20 * tx + r21 * ty + r22 * tz)
  return new Float32Array([
    r00, r10, r20, 0,
    r01, r11, r21, 0,
    r02, r12, r22, 0,
    ex, ey, ez - dist, 1,
  ])
}

/** 编译 shader（失败抛带日志的错，不静默黑屏）。 */
function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (sh === null) throw new Error('starfield: createShader returned null')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (gl.getShaderParameter(sh, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`starfield: shader compile failed: ${String(log)}`)
  }
  return sh
}

/** 链接 program（失败抛带日志的错）。 */
function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc)
  const prog = gl.createProgram()
  if (prog === null) throw new Error('starfield: createProgram returned null')
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (gl.getProgramParameter(prog, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(prog)
    gl.deleteProgram(prog)
    throw new Error(`starfield: program link failed: ${String(log)}`)
  }
  return prog
}

/** 渲染器对外句柄。 */
export interface StarfieldHandle {
  /** 复位镜头。 */
  reset: () => void
  /** 推拉镜头（正数 = 拉近）。 */
  zoomBy: (delta: number) => void
  /** 平滑飞到指定记忆（搜索命中后定位）。传 null 回到整团视角。 */
  focusOn: (target: { id: string } | null) => void
  /** 冻结/恢复动画（选中记忆时停帧，让镜头对得稳）。 */
  setFrozen: (frozen: boolean) => void
  /** 当前相机距离（UI 显示放大倍率）。 */
  getDist: () => number
  /** 是否就绪。 */
  ready: boolean
  /** 初始化失败原因。 */
  error: string | null
  /** 挂到 `<canvas ref={...}>` 的 **callback ref**。 */
  canvasRef: (el: HTMLCanvasElement | null) => void
}

/**
 * 挂载 WebGL 星云渲染器。
 *
 * @param points - 星点（变化时重建 buffer）。
 * @param selectedId - 选中点（高亮）。
 * @param focusId - 搜索定位到的点（额外高亮 + 镜头对准）。
 * @param onPick - 点击命中回调（空白处传 null）。
 * @param onHover - hover 命中的 id + 该点的**屏幕坐标**（CSS 像素，相对 canvas）。
 *   为什么带坐标：用户要求「鼠标移到光点上后**在边上**渲染记忆信息」——信息卡要跟着
 *   指针走，而不是固定在角落（首版放左上角小字，实测「很容易看不到」）。
 * @returns 镜头句柄 + 就绪状态。
 */
export function useStarfield(
  points: readonly StarPoint[],
  selectedId: string | null,
  focusId: string | null,
  onPick: (id: string | null) => void,
  onHover: (id: string | null, x: number, y: number) => void,
): StarfieldHandle {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null)

  /** 时间轴起点（解冻时后移，避免冻结时长被一次性补进动画）。 */
  const startedAtRef = useRef(performance.now())

  const stateRef = useRef({
    dist: DEFAULT_DIST, yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH,
    /** 目标距离：focusOn 时平滑逼近。 */
    targetDist: DEFAULT_DIST,
    /** 相机注视点（平滑逼近 targetGoal）——选中某条记忆时把它移到画面正中。 */
    target: [0, 0, 0] as [number, number, number],
    targetGoal: [0, 0, 0] as [number, number, number],
    /**
     * 冻结时刻（秒）。选中某条记忆后动画**停在这一刻**（用户口径「选中后球体停止
     * 闪烁」）——否则被选中的点会一直公转，镜头追不上、信息面板对着一个动的东西。
     * null = 未冻结（正常播放）。
     */
    frozenAt: null as number | null,
    dirty: true,
    /** CPU 投影结果（拾取用）。 */
    projected: [] as { id: string, x: number, y: number, r: number }[],
    dragging: false, lastX: 0, lastY: 0, moved: false,
    downX: 0, downY: 0,
  })

  const pointsRef = useRef(points)
  const selectedRef = useRef(selectedId)
  const focusRef = useRef(focusId)
  const onPickRef = useRef(onPick)
  const onHoverRef = useRef(onHover)
  const hoverRef = useRef<string | null>(null)
  pointsRef.current = points
  selectedRef.current = selectedId
  focusRef.current = focusId
  onPickRef.current = onPick
  onHoverRef.current = onHover

  const zoomBy = useCallback((delta: number) => {
    const s = stateRef.current
    // **乘性**缩放：远距离每档走得多、近距离走得少 ⇒ 手感一致且「一直能推」
    s.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, s.dist * Math.pow(0.72, delta)))
    s.targetDist = s.dist
    s.dirty = true
  }, [])

  const reset = useCallback(() => {
    const s = stateRef.current
    s.dist = DEFAULT_DIST; s.targetDist = DEFAULT_DIST
    s.yaw = DEFAULT_YAW; s.pitch = DEFAULT_PITCH
    s.dirty = true
  }, [])

  /**
   * 把镜头对准某条记忆：注视点 = 该点位置（⇒ 居中），距离按它所在那一层取景。
   *
   * 位置由**渲染循环**从当前（冻结的）时刻算出来写进 `targetGoal`，这里只定距离
   * ——因为点的位置随时间变，在 React 侧算会用到过期的时间基准。
   *
   * 距离按「该层整体半径」而不是单点半径：内层（永久核 0.34）与最外壳（3.0）差近
   * 一个量级，按单点取景会让内层点仍然很小、外层点糊满屏。
   */
  const focusOn = useCallback((target: { id: string } | null) => {
    const s = stateRef.current
    if (target === null) {
      // 取消聚焦 ⇒ 注视点回到原点（整团星云居中）
      s.targetGoal = [0, 0, 0]
      s.targetDist = DEFAULT_DIST
      s.dirty = true
      return
    }
    const p = pointsRef.current.find(x => x.id === target.id)
    if (p === undefined) return
    // 取景距离：**对准该点（居中）+ 仍能看见星团主体**。
    // 只用 `layerR × 1.5` 时，选中最外壳（半径 3.0）的点会把内层球甩出视野
    // （实测：星团偏到右下、中心只剩一个孤立光斑）。改为取「该层半径 + 内层到注视点
    // 的偏移」：注视点在半径 layerR 处，最远的内层点离它约 layerR，故取 2× 才能
    // 把整团纳入；下限 1.2 保证近层也看得清。
    const layerR = RING_STYLE[p.ring]!.radius
    s.targetDist = Math.max(MIN_DIST, Math.min(MAX_DIST, Math.max(1.2, layerR * 2.0)))
    s.dirty = true
  }, [])

  const setFrozen = useCallback((frozen: boolean) => {
    const s = stateRef.current
    if (frozen) {
      // 记录「冻结这一刻」：首帧时用当前墙钟换算，之后保持不变
      s.frozenAt = (performance.now() - startedAtRef.current) / 1000
    } else {
      // 解冻时把起始时间往后挪，避免时间轴出现「跳变」（冻结期间攒下的时间会被一次性补上）
      startedAtRef.current = performance.now() - (s.frozenAt ?? 0) * 1000
      s.frozenAt = null
    }
    s.dirty = true
  }, [])

  const getDist = useCallback(() => stateRef.current.dist, [])

  useEffect(() => {
    const canvas = canvasEl
    if (canvas === null) return undefined

    let gl: WebGL2RenderingContext | null = null
    try {
      // ⚠️ **必须用预乘 alpha（默认）**。首版写了 `premultipliedAlpha: false` + 加法混合，
      // 结果 alpha 通道被累加到远超 1，浏览器按「非预乘」解读该缓冲时合成异常 ——
      // **整片画布变黑**。极难排查的原因：同帧内 `readPixels` 能读到 6374 个亮像素
      // （证明 shader/实例化/几何全对），只有「合成到页面」这一步错了。
      // 预乘 alpha 下，加法混合的 rgb 已经带 alpha 权重，浏览器合成语义正确。
      gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true })
      if (gl === null) throw new Error('WebGL2 不可用（getContext 返回 null）')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    }
    const ctx = gl

    let prog: WebGLProgram
    try {
      prog = link(ctx, VS, FS)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    }

    const uProj = ctx.getUniformLocation(prog, 'u_proj')
    const uView = ctx.getUniformLocation(prog, 'u_view')
    const uTime = ctx.getUniformLocation(prog, 'u_time')
    const uPulse = ctx.getUniformLocation(prog, 'u_pulse')
    const aCenter = ctx.getAttribLocation(prog, 'a_center')
    const aCorner = ctx.getAttribLocation(prog, 'a_corner')
    const aColor = ctx.getAttribLocation(prog, 'a_color')
    const aRadius = ctx.getAttribLocation(prog, 'a_radius')
    const aPhase = ctx.getAttribLocation(prog, 'a_phase')

    /** 单位方片（两个三角形，6 顶点）。所有光点共用这一份。 */
    const QUAD = new Float32Array([
      -0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
      -0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ])
    const quadBuf = ctx.createBuffer()
    ctx.bindBuffer(ctx.ARRAY_BUFFER, quadBuf)
    ctx.bufferData(ctx.ARRAY_BUFFER, QUAD, ctx.STATIC_DRAW)

    const centerBuf = ctx.createBuffer()
    const colorBuf = ctx.createBuffer()
    const radiusBuf = ctx.createBuffer()
    const phaseBuf = ctx.createBuffer()

    // 背景星尘（远景球壳，纯氛围，不代表记忆）
    const DUST_N = 700
    const dustCenter = new Float32Array(DUST_N * 3)
    const dustColor = new Float32Array(DUST_N * 4)
    const dustRadius = new Float32Array(DUST_N)
    const dustPhase = new Float32Array(DUST_N)
    for (let i = 0; i < DUST_N; i++) {
      // 确定性伪随机（黄金角 + 壳厚）——不用 Math.random，否则每次重挂都重排
      const a = i * 2.399963
      const z = ((i * 0.6180339887) % 1) * 2 - 1
      const sinPhi = Math.sqrt(Math.max(0, 1 - z * z))
      const r = 3.4 + ((i * 0.7548776662) % 1) * 7.0
      dustCenter[i * 3 + 0] = r * sinPhi * Math.cos(a)
      dustCenter[i * 3 + 1] = r * z
      dustCenter[i * 3 + 2] = r * sinPhi * Math.sin(a)
      dustColor[i * 4 + 0] = 0.64; dustColor[i * 4 + 1] = 0.68; dustColor[i * 4 + 2] = 0.88
      dustColor[i * 4 + 3] = 0.18 + ((i * 0.37) % 1) * 0.20
      // 星尘世界半径：同上换算（约 2~8px 直径），别给成亚像素级
      dustRadius[i] = 0.010 + ((i * 0.53) % 1) * 0.020
      dustPhase[i] = ((i * 0.91) % 1) * Math.PI * 2
    }
    const dustBufs = {
      center: ctx.createBuffer(), color: ctx.createBuffer(),
      radius: ctx.createBuffer(), phase: ctx.createBuffer(),
    }
    const upload = (buf: WebGLBuffer | null, data: Float32Array, hint: number) => {
      ctx.bindBuffer(ctx.ARRAY_BUFFER, buf)
      ctx.bufferData(ctx.ARRAY_BUFFER, data, hint)
    }
    upload(dustBufs.center, dustCenter, ctx.STATIC_DRAW)
    upload(dustBufs.color, dustColor, ctx.STATIC_DRAW)
    upload(dustBufs.radius, dustRadius, ctx.STATIC_DRAW)
    upload(dustBufs.phase, dustPhase, ctx.STATIC_DRAW)

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const resize = () => {
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr))
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()

    // 加法混合 + 关深度写 ⇒ 光点叠加发光（开深度测试会把后景硬吃掉，变成死板实心点）
    ctx.enable(ctx.BLEND)
    // 预乘 alpha 下的加法混合：源已含 alpha 权重，故 SRC=ONE（不是 SRC_ALPHA）
    ctx.blendFunc(ctx.ONE, ctx.ONE)
    ctx.disable(ctx.DEPTH_TEST)
    ctx.depthMask(false)
    ctx.clearColor(0, 0, 0, 0)

    // 复用数组（避免每帧分配 typed array 造成 GC 抖动）
    const MAX_N = 20000
    const center = new Float32Array(MAX_N * 3)
    const color = new Float32Array(MAX_N * 4)
    const radius = new Float32Array(MAX_N)
    const phase = new Float32Array(MAX_N)
    const tmp: [number, number, number] = [0, 0, 0]
    const tmpFocus: [number, number, number] = [0, 0, 0]

    let raf = 0
    let disposed = false
    let visible = true
    startedAtRef.current = performance.now()

    const render = () => {
      if (disposed) return
      raf = requestAnimationFrame(render)
      const s = stateRef.current
      // 不可见时停帧（设置面板滚出视口 / 标签页隐藏）
      if (!visible || document.hidden) return
      // ⚠️ **动画场景必须每帧重绘**，不能像静态图那样用 dirty 标记停帧。
      // 首版就栽在这里：`dirty` 画完一帧即置 false ⇒ 循环空转；而 canvas 是
      // `preserveDrawingBuffer: false`（默认），合成后缓冲被清 ⇒ 画布变透明 ⇒
      // 用户看到的是容器底色，**整片全黑**（实测截图确认；而 GL 状态、divisor、
      // viewport 全部正常，CPU 拾取还有 557 次命中——所以极难从状态侧发现问题）。
      // 现在 dirty 只用于「暂停后唤醒」的语义，不再作为每帧闸门。
      s.dirty = false

      // 镜头平滑逼近（focusOn 的飞行效果）
      if (Math.abs(s.dist - s.targetDist) > 0.002) {
        s.dist += (s.targetDist - s.dist) * 0.12
        s.dirty = true
      }

      const now = (performance.now() - startedAtRef.current) / 1000
      // **冻结**：选中某条记忆后动画停在那一瞬（停止闪烁/公转），让镜头能稳稳对住它。
      // 冻结时刻用「最新一次可见的 now」而不是首次冻结的 now —— 后者会让画面向后跳。
      const t = s.frozenAt ?? now
      if (s.frozenAt !== null) s.frozenAt = t

      // 注视点平滑逼近 targetGoal（居中效果）。位置由当前（可能已冻结的）t 算出。
      const focusP = focusRef.current === null
        ? undefined
        : pointsRef.current.find(x => x.id === focusRef.current)
      if (focusP !== undefined) {
        positionAt(focusP, t, tmpFocus)
        s.targetGoal = [tmpFocus[0], tmpFocus[1], tmpFocus[2]]
      }
      const dx = s.targetGoal[0] - s.target[0]
      const dy = s.targetGoal[1] - s.target[1]
      const dz = s.targetGoal[2] - s.target[2]
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 0.0005) {
        s.target[0] += dx * 0.14
        s.target[1] += dy * 0.14
        s.target[2] += dz * 0.14
        s.dirty = true
      } else {
        s.target[0] = s.targetGoal[0]
        s.target[1] = s.targetGoal[1]
        s.target[2] = s.targetGoal[2]
      }

      const aspect = canvas.width / Math.max(1, canvas.height)
      const proj = perspective(FOV, aspect, 0.02, 400)
      const view = viewMatrix(s.dist, s.yaw, s.pitch, s.target[0], s.target[1], s.target[2])

      ctx.viewport(0, 0, canvas.width, canvas.height)
      ctx.clear(ctx.COLOR_BUFFER_BIT)
      ctx.useProgram(prog)
      ctx.uniformMatrix4fv(uProj, false, proj)
      ctx.uniformMatrix4fv(uView, false, view)
      ctx.uniform1f(uTime, t)

      /**
       * 绑定并画一批（**实例化**：单位方片 6 顶点，其余属性每点一份）。
       *
       * divisor 是实例化的关键：`a_corner` divisor=0（每顶点前进）⇒ 6 个顶点铺满方片；
       * 其余 divisor=1（每实例前进）⇒ 每个点读一份自己的 center/color/radius/phase。
       */
      const drawBatch = (
        bufC: WebGLBuffer | null, bufCol: WebGLBuffer | null,
        bufR: WebGLBuffer | null, bufP: WebGLBuffer | null, count: number,
      ) => {
        // 单位方片（每顶点）
        ctx.bindBuffer(ctx.ARRAY_BUFFER, quadBuf)
        ctx.enableVertexAttribArray(aCorner)
        ctx.vertexAttribPointer(aCorner, 2, ctx.FLOAT, false, 0, 0)
        ctx.vertexAttribDivisor(aCorner, 0)
        // 逐实例属性
        const perInstance = (buf: WebGLBuffer | null, loc: number, size: number) => {
          ctx.bindBuffer(ctx.ARRAY_BUFFER, buf)
          ctx.enableVertexAttribArray(loc)
          ctx.vertexAttribPointer(loc, size, ctx.FLOAT, false, 0, 0)
          ctx.vertexAttribDivisor(loc, 1)
        }
        perInstance(bufC, aCenter, 3)
        perInstance(bufCol, aColor, 4)
        perInstance(bufR, aRadius, 1)
        perInstance(bufP, aPhase, 1)
        ctx.drawArraysInstanced(ctx.TRIANGLES, 0, 6, count)
      }

      // ── 背景星尘（整团呼吸 u_pulse=1）────────────────────────────
      ctx.uniform1f(uPulse, 1)
      drawBatch(dustBufs.center, dustBufs.color, dustBufs.radius, dustBufs.phase, DUST_N)

      // ── 记忆光点 ────────────────────────────────────────────────
      const pts = pointsRef.current
      const n = Math.min(pts.length, MAX_N)

      // 密度补偿：加法混合下同层点互相叠加，条数一多就糊（实测 1000 条糊成白团）。
      // 四次方根（比 sqrt 温和）+ alpha 下限 0.42 —— 既不过曝也不消失。
      const REF = 40
      const ringCount = [0, 0, 0, 0]
      for (let i = 0; i < n; i++) ringCount[pts[i]!.ring]! += 1
      const dens = ringCount.map(c => (c <= REF ? 1 : Math.pow(REF / c, 0.25)))

      for (let i = 0; i < n; i++) {
        const p = pts[i]!
        const ring = RING_STYLE[p.ring]!
        // ⚠️ 与拾取（CPU）共用 positionAt —— 否则点击位置会与看到的光点错位
        positionAt(p, t, tmp)
        center[i * 3 + 0] = tmp[0]
        center[i * 3 + 1] = tmp[1]
        center[i * 3 + 2] = tmp[2]
        const isSel = p.id === selectedRef.current
        const isFocus = p.id === focusRef.current
        const imp = Math.max(0, Math.min(100, p.importance)) / 100
        color[i * 4 + 0] = ring.rgb[0]!
        color[i * 4 + 1] = ring.rgb[1]!
        color[i * 4 + 2] = ring.rgb[2]!
        // 上限提到 1.0（预乘后 alpha 直接决定亮度）；下限 0.5 保证密集层不消失
        const baseA = p.applicable ? 0.62 + imp * 0.38 : 0.22
        color[i * 4 + 3] = Math.max(baseA * dens[p.ring]!, 0.5) * (isSel || isFocus ? 1.0 : 0.92)
        // **世界空间**半径：随距离自然缩放 ⇒ 不受 gl_PointSize 钳制，放大不糊。
        // ⚠️ 量级要按「投影后的像素直径」核对，不要凭感觉给：默认机位下
        // `直径px ≈ radius × 2 × (H/2/tan(FOV/2)) / dist`，H=936、FOV=0.9、dist=9.2
        // ⇒ 系数约 211。首版给 0.0075~0.018 ⇒ 只有 1.6~3.8px 直径，再乘片元的
        // `pow(1-r,3.2)` 陡衰减 ⇒ **整片几乎看不见**（实测全黑的第二个原因）。
        // 现给 0.026~0.062 ⇒ 约 11~26px 直径，与上一版可见时的 4~16px 同量级偏大。
        radius[i] = (0.038 + imp * 0.050) * (isSel ? 1.9 : (isFocus ? 2.3 : 1.0))
        phase[i] = p.phase
      }

      if (n > 0) {
        upload(centerBuf, center.subarray(0, n * 3), ctx.DYNAMIC_DRAW)
        upload(colorBuf, color.subarray(0, n * 4), ctx.DYNAMIC_DRAW)
        upload(radiusBuf, radius.subarray(0, n), ctx.DYNAMIC_DRAW)
        upload(phaseBuf, phase.subarray(0, n), ctx.DYNAMIC_DRAW)
        // 整团轻微脉动（0.985~1.015）：让静止时也有「活着」的观感
        ctx.uniform1f(uPulse, 1 + Math.sin(t * 0.55) * 0.015)
        drawBatch(centerBuf, colorBuf, radiusBuf, phaseBuf, n)

        // CPU 端投影（拾取）：与 GPU 同一套矩阵 + 同一个 positionAt
        const f = 1 / Math.tan(FOV / 2)
        const halfW = canvas.width / 2
        const halfH = canvas.height / 2
        s.projected.length = 0
        for (let i = 0; i < n; i++) {
          const x = center[i * 3 + 0]!, y = center[i * 3 + 1]!, z = center[i * 3 + 2]!
          const vx = view[0]! * x + view[4]! * y + view[8]! * z + view[12]!
          const vy = view[1]! * x + view[5]! * y + view[9]! * z + view[13]!
          const vz = view[2]! * x + view[6]! * y + view[10]! * z + view[14]!
          const depth = -vz
          if (depth <= 0.01) continue
          const sx = ((f / aspect) * vx / depth) * halfW + halfW
          const sy = halfH - (f * vy / depth) * halfH
          // 拾取半径 = 该点投影后的像素半径，下限 8px（鼠标/触摸都点得中）
          const pr = Math.max(8 * dpr, (radius[i]! / depth) * f * halfH)
          s.projected.push({ id: pts[i]!.id, x: sx, y: sy, r: pr })
        }
      } else {
        s.projected.length = 0
      }
    }
    raf = requestAnimationFrame(render)
    setReady(true)

    // 可见性：滚出视口 / 标签页隐藏时停帧（设置面板不该在后台烧 GPU）
    //
    // ⚠️ `visible` 的初值必须是 **true**，且不能被「观察者还没回调」卡住：
    // 首版把它交给 IntersectionObserver 的**首次回调**决定，于是「切到列表视图
    // （canvas 卸载 → 清理）→ 切回星云（新 canvas 挂载）」这条路径上，新 observer 的
    // 首次回调可能因为初始交叉状态没变化而不触发 ⇒ `visible` 永远是 false ⇒
    // **渲染永久停止**（实测：切回来整片空白、draw call = 0）。
    // 修法：初值 true（挂载即可见是默认情形），观察者只负责**后续**把它改回 false/true。
    visible = true
    const io = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1]
      if (entry === undefined) return
      visible = entry.isIntersecting
      if (visible) stateRef.current.dirty = true
    }, { threshold: 0 })
    io.observe(canvas)
    const onVis = () => { if (!document.hidden) stateRef.current.dirty = true }
    document.addEventListener('visibilitychange', onVis)

    // ── 交互（拾取：CPU 反投影最近命中）────────────────────────────
    const hit = (cx: number, cy: number): string | null => {
      const s = stateRef.current
      const px = cx * dpr
      const py = cy * dpr
      let best: string | null = null
      let bestD = Number.POSITIVE_INFINITY
      for (const p of s.projected) {
        const d = Math.hypot(p.x - px, p.y - py)
        if (d <= p.r + 6 * dpr && d < bestD) { bestD = d; best = p.id }
      }
      return best
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = stateRef.current
      s.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, s.dist * Math.pow(1.0016, e.deltaY)))
      s.targetDist = s.dist
      s.dirty = true
    }
    const onDown = (e: PointerEvent) => {
      const s = stateRef.current
      s.dragging = true; s.moved = false
      s.lastX = e.clientX; s.lastY = e.clientY
      s.downX = e.clientX; s.downY = e.clientY
      // `setPointerCapture` 会抛（合成事件 / pointerId 已失效 / 部分设备）——
      // 不捕获也不影响本实现（拖拽靠 pointermove + 元素内判定），但**抛错会中断
      // 后续逻辑**，进而让点击选中失效（实测：合成事件下完全点不中）。
      try { canvas.setPointerCapture(e.pointerId) } catch { /* 无捕获也能拖 */ }
    }
    const onMove = (e: PointerEvent) => {
      const s = stateRef.current
      const r = canvas.getBoundingClientRect()
      if (s.dragging) {
        if (hoverRef.current !== null) { hoverRef.current = null; onHoverRef.current(null, 0, 0) }
        const dx = e.clientX - s.lastX
        const dy = e.clientY - s.lastY
        if (Math.hypot(e.clientX - s.downX, e.clientY - s.downY) > 4) s.moved = true
        // 旋转速度随距离缩放：拉近时转角要小（否则一转就飞出去）
        const k = 0.005 * Math.min(1, s.dist / DEFAULT_DIST + 0.15)
        s.yaw += dx * k
        s.pitch = Math.max(-1.45, Math.min(1.45, s.pitch + dy * k * 0.85))
        s.lastX = e.clientX; s.lastY = e.clientY
        s.dirty = true
        return
      }
      const id = hit(e.clientX - r.left, e.clientY - r.top)
      // 每次都上报坐标（不只是 id 变化时）：浮卡要贴着指针移动。
      if (id !== hoverRef.current) {
        hoverRef.current = id
        canvas.style.cursor = id === null ? 'grab' : 'pointer'
      }
      // 命中时用**光点中心**的坐标（不是指针坐标）—— 浮卡贴着光点更稳，
      // 不会因为指针微动而抖。
      if (id === null) {
        onHoverRef.current(null, 0, 0)
      } else {
        const pr = s.projected.find(p => p.id === id)
        onHoverRef.current(id, pr === undefined ? 0 : pr.x / dpr, pr === undefined ? 0 : pr.y / dpr)
      }
    }
    const onUp = (e: PointerEvent) => {
      const s = stateRef.current
      if (s.dragging && !s.moved) {
        const r = canvas.getBoundingClientRect()
        onPickRef.current(hit(e.clientX - r.left, e.clientY - r.top))
      }
      s.dragging = false
      try {
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      } catch { /* 未捕获或已释放：忽略 */ }
    }
    const onLeave = () => {
      hoverRef.current = null
      onHoverRef.current(null, 0, 0)
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointerleave', onLeave)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      ctx.deleteProgram(prog)
      for (const b of [quadBuf, centerBuf, colorBuf, radiusBuf, phaseBuf,
        dustBufs.center, dustBufs.color, dustBufs.radius, dustBufs.phase]) {
        ctx.deleteBuffer(b)
      }
      setReady(false)
    }
  }, [canvasEl])

  useEffect(() => { stateRef.current.dirty = true }, [points, selectedId, focusId])

  return { reset, zoomBy, focusOn, setFrozen, getDist, ready, error, canvasRef: setCanvasEl }
}
