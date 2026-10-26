/**
 * 第4层分流与即时执行转发（`docs/intelligent_routing_design.md` §2 第 15 行）。
 *
 * 分流判定（`decideTier4`，纯函数）默认 `strict` 档，四道闸门**同时**成立才转交：
 *   ① 形态：用户**显式给出一个链接**（整条消息是 URL／裸域名，或 ≤64 字且句首是显式开页意图）；
 *   ② 承接：该 host 本地**无任何承接者**（已注册 adapter（含禁用）/ `*.` 通配子域 / 已毕业
 *      toolkit skill / 用户目录已装包），有的交回模型用本地工具；
 *   ③ 权限：仅 `full` 模式；
 *   ④ 判定：siteGate `miss`（`ambiguous` / `disabled` 不转交），且 env 急停未关。
 *
 * 为什么第 ① 条必须这么窄：本层一旦触发就**整轮替换事件源**（`server.ts` 的
 * `tier4Source ?? streamChat`），本轮模型手里的全部工具都不可达——包括探索自己生成的 adapter
 * 与后续接入的其它探索类工具。旧口径「句子里出现未注册域名就转交」会静默抢答这些工具。
 *
 * 执行（`runWebwrightTaskTurn`）：网站探索agent任务事件 → 既有 chat `SSEEvent` 序列；
 * 超时/中止取消任务；`waiting_for_user` 引导去网站探索agent UI 接管（不是错误）。
 *
 * UI 与用户可见文案统一写「网站探索agent」，不出现内部组件名（见 AGENTS.md 红线）。
 */
import type { SSEEvent } from './agent.js'
import type { SiteGateResult } from './site-gate.js'
import type { ParsedAdapter } from './adapter-parser.js'
import {
  cancelWebwrightTask,
  createWebwrightTask,
  fetchWebwrightTask,
  openWebwrightTaskEvents,
  type WebwrightClientDeps,
} from './webwright-client.js'

export const WEBWRIGHT_UI_URL = 'http://127.0.0.1:8766/ui'

/**
 * 任务入口链接文案：URL **独立成行**，括号说明另起一行。
 *
 * 为什么不能把 URL 嵌进中文句子：聊天里的自动链接与系统「打开外部链接」会把紧贴 URL 的中文
 * 一并吞进 URL——实测 2026-10-12 用户点开失败文案里的入口，服务端收到的是
 * `/ui%EF%BF%BD…`（URL 后紧跟的全角「（任务」被按单字节解码成替换字符）→ 404，轨迹入口失效。
 * 故凡输出该链接处一律经此函数，URL 两侧只留行边界，绝不与中文直接相邻。
 *
 * 括号行只写**事实**：`/ui` 是 Adapter 工作台（站点能力固化入口），不展示这一次聊天任务的
 * 逐步轨迹，所以不能承诺「查看逐步轨迹/截图」。
 */
function taskLink(taskId: string): string {
  return `${WEBWRIGHT_UI_URL}\n（任务 ${taskId}；该入口是 Adapter 工作台，可把常用站点固化成工具）`
}

// ─── 站点信号提取（纯）────────────────────────────────────────────────────

/** TLD 为常见文件扩展名的不算站点信号（防「下载 v1.2.zip」误判）。 */
const FILE_EXTENSION_TLDS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'exe', 'msi', 'dmg', 'pkg', 'apk',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'pdf', 'doc', 'docx',
  'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'md', 'log', 'js', 'ts', 'py',
  'json', 'xml', 'html', 'htm', 'css', 'yaml', 'yml',
])

const URL_RE = /https?:\/\/[^\s<>"'`]+/i
const BARE_DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b(?::\d{2,5})?(?:\/[^\s<>"'`]*)?/i

/** `www.` / `m.` / `mobile.` 只是同一站点的入口别名，不构成独立站点。 */
const WEB_HOST_LABELS = new Set(['www', 'm', 'mobile'])
const MAX_HOST_LENGTH = 253

function stripTrailingPunctuation(raw: string): string {
  return raw.replace(/[.,;:!?()[\]{}<>"'`、。，；！？）】…—-]+$/g, '')
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * host 归一化：小写、去端口、去末尾点、去 scheme/路径。
 *
 * 为什么必须归一：`match` 里既写 `example.com` 又写 `www.example.com`（各 adapter 不一致），
 * 而用户粘贴的链接带 `www.`/端口/末尾点是常态。不归一就会把「已注册站点」判成「未注册」，
 * 于是第 4 层抢答本该由本地工具回答的请求。
 */
export function normalizeHost(raw: string): string {
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return ''
  let host = hostOf(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`)
  if (!host) host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0]
  host = host.replace(/:\d+$/, '').replace(/\.+$/, '')
  return host.length > MAX_HOST_LENGTH ? '' : host
}

/** 同站别名：`www.x.com` 与 `x.com` 视为同一个站点（只剥一层 web 入口前缀）。 */
export function hostAliasVariants(host: string): string[] {
  const normalized = normalizeHost(host)
  if (!normalized) return []
  const dot = normalized.indexOf('.')
  if (dot <= 0) return [normalized]
  const first = normalized.slice(0, dot)
  const rest = normalized.slice(dot + 1)
  // `rest` 必须仍是域名（含点），否则 `www.localhost` 会被剥成单标签。
  if (WEB_HOST_LABELS.has(first) && rest.includes('.')) return [normalized, rest]
  return [normalized]
}

/** 把一条 manifest `match` / toolkit `allowed_domains` 条目写入已知站点集合（含 `*.` 通配）。 */
function addKnownHost(hosts: Set<string>, raw: string): void {
  const entry = String(raw ?? '').trim().toLowerCase()
  if (!entry) return
  if (entry.startsWith('*.')) {
    const suffix = normalizeHost(entry.slice(2))
    if (!suffix) return
    hosts.add(`*.${suffix}`)
    for (const variant of hostAliasVariants(suffix)) hosts.add(variant)
    return
  }
  for (const variant of hostAliasVariants(entry)) hosts.add(variant)
}

/**
 * 已知站点集合 = 任何已注册 adapter 的 `match` 条目（含禁用——用户禁用的站点不得绕道第4层复活）。
 * 可追加额外来源（已毕业 toolkit skill 的 `allowed_domains`、用户目录已安装 adapter）。
 */
export function buildKnownHosts(
  allAdapters: Map<string, ParsedAdapter>,
  extraHosts: Iterable<string> = [],
): Set<string> {
  const hosts = new Set<string>()
  for (const adapter of allAdapters.values()) {
    for (const match of adapter.match ?? []) addKnownHost(hosts, String(match))
  }
  for (const host of extraHosts) addKnownHost(hosts, host)
  return hosts
}

/** 该 host 是否已有本地承接者（精确 / 同站别名 / `*.` 通配三种口径）。 */
export function isKnownSiteHost(host: string, knownHosts: Iterable<string>): boolean {
  const variants = hostAliasVariants(host)
  if (!variants.length) return false
  const known: Set<string> = knownHosts instanceof Set ? (knownHosts as Set<string>) : new Set(knownHosts)
  for (const variant of variants) if (known.has(variant)) return true
  for (const entry of known) {
    if (!entry.startsWith('*.')) continue
    const suffix = entry.slice(2)
    for (const variant of variants) {
      if (variant === suffix || variant.endsWith(`.${suffix}`)) return true
    }
  }
  return false
}

/** 消息里的站点候选（含 scheme、已剥尾部标点、已排除文件扩展名 TLD），保持出现顺序。 */
function siteTokens(text: string): string[] {
  const candidates = [
    ...(text.match(URL_RE) ?? []).map(stripTrailingPunctuation),
    ...(text.match(BARE_DOMAIN_RE) ?? []).map(stripTrailingPunctuation),
  ].filter(Boolean)
  const tokens: string[] = []
  for (const candidate of candidates) {
    const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`
    const host = hostOf(withScheme)
    if (!host) continue
    if (FILE_EXTENSION_TLDS.has(host.slice(host.lastIndexOf('.') + 1))) continue
    tokens.push(withScheme)
  }
  return tokens
}

/** 消息里第一个站点信号（不区分是否已注册）；无信号 → null。 */
export function firstSiteToken(message: string): string | null {
  return siteTokens(String(message || ''))[0] ?? null
}

/**
 * 提取消息指向的第一个「未注册站点」URL（归一化为含 scheme 的 start_url）；无信号/首个信号为已知站点 → null。
 *
 * **只认首个信号**：消息里先出现已注册站点时，视为「用户当下说的是这个站点」，不再去找后面的未注册域名。
 * 这是刻意的保守取舍——考虑后续域名只会**扩大**第 4 层转发面，而漏判的代价只是落回第 3 层
 * （设计允许的方向）。
 *
 * 注：旧实现对该情况是 `continue`（跳过已知站点、继续返回后面的未注册域名），与上面这条口径
 * 正好相反；现按口径实现，方向上是**减少**转交。
 */
export function extractUnknownSiteUrl(
  message: string,
  knownHosts: Iterable<string>,
  extraHosts: Iterable<string> = [],
): string | null {
  const known = new Set(knownHosts)
  for (const host of extraHosts) addKnownHost(known, host)
  const token = firstSiteToken(message)
  if (!token) return null
  if (isKnownSiteHost(hostOf(token), known)) return null
  return token
}

// ─── 分流判定（纯）────────────────────────────────────────────────────────

export interface Tier4Decision {
  dispatch: boolean
  /** `dispatch=true` 时的起点 URL。 */
  startUrl: string | null
  /** 观测/调试用：不转发的判定原因。 */
  reason: string
}

/**
 * 触发档位：
 * - `strict`（默认）——只有「用户显式给出一个链接」的输入环境才允许第 4 层接手；
 * - `legacy`——今天的宽触发（任意含未注册域名的句子都转交），仅用于一键回退。
 *
 * host 归一化（`www.` 别名 / `*.` 通配）在两种档位都生效：它只把「已注册站点」认得更全，
 * 方向上是**减少**转交（漏判免费），不属于闸门范围。
 */
export type Tier4TriggerMode = 'strict' | 'legacy'

export type Tier4PermissionMode = 'qa_only' | 'no_bash' | 'full'

export interface Tier4DecisionDeps {
  /** 额外的已知站点来源（已毕业 toolkit skill 的 `allowed_domains` 等）。 */
  extraKnownHosts?: Iterable<string>
  /** 当前会话权限模式。第 4 层会拉起浏览器并写用户目录，只在 `full` 下自动转交。 */
  permissionMode?: Tier4PermissionMode
  /** 触发档位；缺省读 `WEWORKER_TIER4_TRIGGER`（`legacy` 才回退，其余一律 strict）。 */
  triggerMode?: Tier4TriggerMode
}

export function tier4TriggerMode(): Tier4TriggerMode {
  return String(process.env.WEWORKER_TIER4_TRIGGER || '').trim().toLowerCase() === 'legacy'
    ? 'legacy'
    : 'strict'
}

/** 显式链接输入的短句上限：超过这个长度就不算「用户给了一个链接」，而是普通对话里提到了域名。 */
export const TIER4_EXPLICIT_LINK_MAX_CHARS = 64

/** 显式开页意图（句首，允许礼貌前缀）：没有这个动词的长句即便带链接也不自动转交。 */
const OPEN_INTENT_RE =
  /^(?:请|麻烦|帮我|帮忙)?\s*(?:打开|看看|看一下|看一眼|看下|瞧瞧|查看|浏览|访问|分析一下|分析|解析|open|visit|check out|look at|have a look at|analy[sz]e)/i

const WHOLE_URL_RE = /^https?:\/\/[^\s<>"'`]+$/i
const WHOLE_DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i
const SURROUNDING = /^[<「『("'（【\[]\s*|\s*[>」』)"'）】\]]$/g

function unwrapQuotes(text: string): string {
  let out = text
  for (let i = 0; i < 2; i += 1) {
    const next = out.replace(SURROUNDING, '')
    if (next === out) break
    out = next
  }
  return out
}

/**
 * 形态闸门：这是不是「用户显式给出一个链接」的输入环境？
 *
 * 放行的三种形态（其余一律不自动转交）：
 * 1. 整条消息就是一个 URL；
 * 2. 整条消息就是一个裸域名（`shop.example.org`）；
 * 3. ≤64 字的短句，且**句首**是显式开页意图（打开 / 看看 / 分析…），句中带链接或域名。
 *
 * 为什么收这么窄：第 4 层一旦触发会整轮替换事件源（`server.ts` 的 `tier4Source ?? streamChat`），
 * 本轮模型手里的全部工具（含探索生成的 adapter 与 toolkit skill 工具）都不可达。所以只认
 * 「用户就是在给一个链接」这一种输入环境，避免抢答普通对话与后续接入的探索类工具。
 */
export function isExplicitLinkInput(message: string): boolean {
  const raw = String(message ?? '').trim()
  if (!raw) return false
  // `!` 是显式点名工具：让位给别名校验，绝不升级成探索任务。
  if (raw.startsWith('!')) return false
  const text = unwrapQuotes(stripTrailingPunctuation(raw))
  if (!text) return false
  if (WHOLE_URL_RE.test(text)) return true
  if (!/\s/.test(text) && WHOLE_DOMAIN_RE.test(text)) {
    const tld = text.slice(text.lastIndexOf('.') + 1)
    if (!FILE_EXTENSION_TLDS.has(tld)) return true
  }
  if (text.length > TIER4_EXPLICIT_LINK_MAX_CHARS) return false
  if (!OPEN_INTENT_RE.test(text)) return false
  return firstSiteToken(text) !== null
}

export function decideTier4(
  message: string,
  siteGate: SiteGateResult,
  allAdapters: Map<string, ParsedAdapter>,
  deps: Tier4DecisionDeps = {},
): Tier4Decision {
  if (process.env.WEWORKER_TIER4 === '0') return { dispatch: false, startUrl: null, reason: 'env-off' }
  if (siteGate.reason !== 'miss') return { dispatch: false, startUrl: null, reason: `sitegate-${siteGate.reason}` }

  const mode = deps.triggerMode ?? tier4TriggerMode()
  if (mode === 'strict') {
    // 闸门④（权限）：探索会拉起浏览器并写用户目录，受限权限模式一律交回模型。
    const permissionMode = deps.permissionMode ?? 'full'
    if (permissionMode !== 'full') {
      return { dispatch: false, startUrl: null, reason: `permission-${permissionMode}` }
    }
    // 闸门①（形态）：不是「显式给链接」的输入环境 → 不转交。
    if (!isExplicitLinkInput(message)) {
      return { dispatch: false, startUrl: null, reason: 'not-explicit-link' }
    }
  }

  const token = firstSiteToken(message)
  if (!token) return { dispatch: false, startUrl: null, reason: 'no-unknown-site-signal' }
  // 闸门②（承接）：该 host 已有本地能力（adapter / 已毕业 toolkit / 用户目录已装包）→ 交回模型。
  const knownHosts = buildKnownHosts(allAdapters, deps.extraKnownHosts ?? [])
  if (isKnownSiteHost(hostOf(token), knownHosts)) {
    // legacy 档沿用旧 reason，保证回退时日志口径与迁移前一致（便于对照历史日志）。
    return { dispatch: false, startUrl: null, reason: mode === 'strict' ? 'local-capability' : 'no-unknown-site-signal' }
  }
  return { dispatch: true, startUrl: token, reason: 'unknown-site' }
}

// ─── 即时执行回合（async generator）──────────────────────────────────────

export function isTier4Enabled(): boolean {
  return process.env.WEWORKER_TIER4 !== '0'
}

export function tier4TimeoutMs(): number {
  const raw = Number(process.env.WEWORKER_TIER4_TIMEOUT_MS || '')
  return Number.isFinite(raw) && raw >= 30_000 ? raw : 10 * 60_000
}

const READ_ONLY_GUARD =
  '（系统护栏：本次为客户端自动转交的任务，请只做浏览与信息获取，不要执行提交、下单、发送、删除等写入操作；若任务必须写入，请暂停并等待用户接管。）'

export function buildTier4Instruction(message: string): string {
  if (process.env.WEWORKER_TIER4_ALLOW_WRITES === '1') return message
  return `${message}\n\n${READ_ONLY_GUARD}`
}

/**
 * 建任务（成功才进入执行流）。失败返回 `{ok:false}`，调用方落回第3层。
 * 与 `runWebwrightTaskTurn` 分离：调用方需要在「换事件源」之前知道建任务结果。
 */
export async function openTier4Turn(input: {
  message: string
  startUrl: string
  title?: string
  abortSignal?: AbortSignal
  deps?: WebwrightClientDeps
  now?: () => number
}): Promise<{ ok: true; taskId: string; run: AsyncGenerator<SSEEvent> } | { ok: false; code: string; message: string }> {
  const created = await createWebwrightTask(
    { instruction: buildTier4Instruction(input.message), startUrl: input.startUrl, title: input.title },
    input.deps,
  )
  if (!created.ok) return { ok: false, code: created.code, message: created.message }
  return {
    ok: true,
    taskId: created.taskId,
    run: runWebwrightTaskTurn({
      taskId: created.taskId,
      startUrl: input.startUrl,
      abortSignal: input.abortSignal,
      deps: input.deps,
      now: input.now,
    }),
  }
}

export async function* runWebwrightTaskTurn(input: {
  taskId: string
  startUrl: string
  abortSignal?: AbortSignal
  deps?: WebwrightClientDeps
  now?: () => number
}): AsyncGenerator<SSEEvent> {
  const now = input.now ?? Date.now
  const taskId = input.taskId
  const link = taskLink(taskId)
  // 起点同样独立成行：URL 后面紧跟全角括号时会被链接器吞进去（同 taskLink 的成因）。
  yield {
    type: 'text_delta',
    content: `已识别出尚未接入的站点，转交网站探索agent执行本次请求。\n起点：${input.startUrl}\n\n`,
  }

  const opened = await openWebwrightTaskEvents(taskId, input.deps)
  if (!opened.ok) {
    await cancelWebwrightTask(taskId, input.deps)
    yield {
      type: 'text_delta',
      content: `任务事件流打开失败（${opened.reason}），已取消本次任务。原始请求请稍后重试，或直接在浏览器打开：\n${WEBWRIGHT_UI_URL}`,
    }
    return
  }

  const deadline = now() + tier4TimeoutMs()
  let lastStep = 0
  try {
    for await (const ev of opened.events) {
      if (input.abortSignal?.aborted) break
      if (now() > deadline) {
        await cancelWebwrightTask(taskId, input.deps)
        yield {
          type: 'text_delta',
          content: `\n\n任务超过时限（${Math.round(tier4TimeoutMs() / 60_000)} 分钟），已请求取消；如需继续：\n${link}`,
        }
        return
      }
      const data = ev.data ?? {}
      if (ev.event === 'step_finished') {
        const step = Number(data.step ?? 0)
        if (step > lastStep) {
          lastStep = step
          yield { type: 'text_delta', content: `[执行] 步骤 ${step} 完成\n` }
        }
      } else if (ev.event === 'task_started') {
        yield { type: 'text_delta', content: `[执行] 浏览器已启动，开始执行…\n` }
      } else if (ev.event === 'waiting_for_user') {
        yield { type: 'text_delta', content: `\n\n任务已暂停，等待人工接管。请在以下入口完成所需操作后继续：\n${link}` }
        return
      } else if (ev.event === 'task_succeeded') {
        const task = await fetchWebwrightTask(taskId, input.deps)
        const final = String(task?.final_response ?? '').trim()
        yield {
          type: 'text_delta',
          content: final
            ? `\n\n${final}\n\n---\n（以上由网站探索agent完成，共 ${task?.current_step ?? lastStep} 步）\n${link}`
            : `\n\n任务已完成（${task?.current_step ?? lastStep} 步），但未生成总结。详情：\n${link}`,
        }
        return
      } else if (ev.event === 'task_failed' || ev.event === 'task_cancelled') {
        const task = await fetchWebwrightTask(taskId, input.deps)
        const detail = String(task?.error ?? '').trim() || ev.event
        yield { type: 'text_delta', content: `\n\n任务未完成（${detail}）。\n可在以下入口查看，或换一种问法再让我处理：\n${link}` }
        return
      }
      // pause_requested / cancel_requested / 其他中间态：不打扰用户，继续等待。
    }
    // 用户中止：静默返回（对齐 streamChat 的 AbortError 语义），取消交给 finally。
    if (input.abortSignal?.aborted) return
    // 事件流意外关闭且未收到停态：拉一次任务视图定性。
    const task = await fetchWebwrightTask(taskId, input.deps)
    const status = task?.status ?? 'unknown'
    if (status === 'succeeded') {
      const final = String(task?.final_response ?? '').trim()
      yield { type: 'text_delta', content: `\n\n${final || '任务已完成。'}\n\n---\n${link}` }
    } else {
      await cancelWebwrightTask(taskId, input.deps)
      yield { type: 'text_delta', content: `\n\n任务进度流中断（状态 ${status}），已请求取消；如需继续：\n${link}` }
    }
  } finally {
    // 用户中止：尽力取消远端任务，避免浏览器继续空转。
    if (input.abortSignal?.aborted) await cancelWebwrightTask(taskId, input.deps)
  }
}
