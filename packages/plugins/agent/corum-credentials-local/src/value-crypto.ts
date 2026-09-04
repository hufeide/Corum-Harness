/**
 * fork（corum）：凭证值加密层（官方 dsh-credentials-local 无此文件）。
 *
 * 官方基线把 ref 值与 api-key record 的 key/env 值**明文**写入
 * `$DSH_HOME/.credentials.yaml`（`assertOwnerOnly` 只校验 0600 权限；官方注释
 * 明言 "the file's protection is skipped rather than faked"）。corum 发行版的
 * 安全基线是「API Key 必须本地加密落盘」，故本模块在 durable 边界上提供
 * 逐条加密：
 *
 * - **加密格式**：`enc:v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>`，
 *   AES-256-GCM（认证加密，篡改即解密失败），随机 96-bit IV 逐条生成。
 * - **主密钥**：由 Electron main 进程生成（32 字节随机），经
 *   `safeStorage.encryptString`（macOS Keychain / Windows DPAPI）封装后落盘
 *   `$CORUM_HOME/.master-key`，明文主密钥只经环境变量
 *   `CORUM_CREDENTIALS_MASTER_KEY`（base64）传给 host 子进程——与本模块顶部的
 *   inherited-environment 语义同构：进入进程环境的值即「该次启动的显式意图」。
 * - **双读兼容**：不带 `enc:v1:` 前缀的存量明文条目按明文读（不写回），
 *   写入一律密文——用户的既有 Key 在升级后不丢、可正常读取，并随下一次
 *   写入自动转为密文。
 * - **无密钥降级**：未注入主密钥（例如非 Electron 承载的 `dsh web` 直跑
 *   本 overlay）时**写时拒绝、密文条目读时抛错、明文条目仍按明文读**——
 *   绝不静默退回明文写，让「加密落盘」承诺永远成立。
 *
 * 只加密**值**，不加密结构：ref 名 / record 键 / grant payload 保持明文，
 * 官方解析器（`parseRefs`/`parseRecord`/`assertFields`）对未知字段的严格
 * 拒绝语义逐行保留。
 * @module @corum/corum-credentials-local/value-crypto
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** 密文值前缀（version 段内嵌；v1 = AES-256-GCM + base64 段）。 */
const ENCRYPTED_PREFIX = 'enc:v1:'

/** 注入主密钥的环境变量名（Electron main 经 buildHostEnv 注入，base64 编码的 32 字节）。 */
export const MASTER_KEY_ENV = 'CORUM_CREDENTIALS_MASTER_KEY'

/** AES-256-GCM 参数：32 字节密钥、12 字节 IV（NIST 推荐 96-bit）、16 字节认证标签。 */
const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

/**
 * 进程内主密钥缓存：env 是 boot 早期由 main 注入的不可变输入，每次加解密都
 * 重读 env 没有必要；首次解析即定型（解析失败也定型为 undefined 走降级路径）。
 */
let cachedKey: Buffer | null | undefined

/**
 * 从注入的环境变量解析主密钥；未注入或格式非法返回 `null`（降级语义见模块头）。
 * @returns 32 字节主密钥，或 `null` 表示不可用。
 */
function masterKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey
  const raw = process.env[MASTER_KEY_ENV]
  if (raw === undefined || raw.trim() === '') {
    cachedKey = null
    return cachedKey
  }
  let key: Buffer
  try {
    key = Buffer.from(raw, 'base64')
  } catch {
    cachedKey = null
    return cachedKey
  }
  if (key.length !== KEY_BYTES) {
    cachedKey = null
    return cachedKey
  }
  cachedKey = key
  return cachedKey
}

/** 测试专用：重置主密钥缓存（本进程的 env 在 boot 后是定值，只有测试需要重判）。 */
export function resetMasterKeyCacheForTest(): void {
  cachedKey = undefined
}

/** 加密层是否可用（主密钥已注入）。UI/诊断面可据此区分「密文存储」与「降级不可用」。 */
export function encryptionAvailable(): boolean {
  return masterKey() !== null
}

/** 判断一个落盘值是否为密文（双读分流入口）。 */
export function isEncryptedValue(stored: string): boolean {
  return stored.startsWith(ENCRYPTED_PREFIX)
}

/**
 * 加密一个凭证值为可落盘字符串。密钥不可用时拒绝（不静默退回明文）。
 * @param plaintext - 明文值（UTF-8）。
 * @returns `enc:v1:` 前缀的密文值。
 * @throws 主密钥未注入时。
 */
export function encryptValue(plaintext: string): string {
  const key = masterKey()
  if (key === null) {
    throw new Error(
      'credentials-local(encrypted): the master key is unavailable — refusing to store a credential in plaintext. '
      + `The desktop shell injects ${MASTER_KEY_ENV} via safeStorage; store this credential from the desktop app.`,
    )
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_BYTES })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return ENCRYPTED_PREFIX
    + `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`
}

/**
 * 解密一个落盘值；不带 `enc:v1:` 前缀的值按明文原样返回（双读兼容）。
 * @param stored - 落盘值（密文或存量明文）。
 * @returns 明文值。
 * @throws 密文但密钥不可用、格式损坏或认证失败（篡改）时。
 */
export function decryptValue(stored: string): string {
  if (!isEncryptedValue(stored)) return stored
  const key = masterKey()
  if (key === null) {
    throw new Error(
      'credentials-local(encrypted): a stored credential is encrypted but the master key is unavailable '
      + `— start the desktop app so ${MASTER_KEY_ENV} is injected; the value is never written to disk in plaintext.`,
    )
  }
  const body = stored.slice(ENCRYPTED_PREFIX.length)
  const parts = body.split(':')
  if (parts.length !== 3) {
    throw new Error('credentials-local(encrypted): malformed encrypted value (expected iv:tag:ciphertext)')
  }
  const [ivB64, tagB64, dataB64] = parts
  let iv: Buffer
  let authTag: Buffer
  let ciphertext: Buffer
  try {
    iv = Buffer.from(ivB64, 'base64')
    authTag = Buffer.from(tagB64, 'base64')
    ciphertext = Buffer.from(dataB64, 'base64')
  } catch {
    throw new Error('credentials-local(encrypted): malformed encrypted value (base64 decode failed)')
  }
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error('credentials-local(encrypted): malformed encrypted value (bad iv/tag length)')
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_BYTES })
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    // GCM 认证失败 = 文件被篡改或主密钥不匹配；不泄露任何明文线索。
    throw new Error('credentials-local(encrypted): decryption failed (authentication tag mismatch)')
  }
}
