// 容错 JSON 解析:支持尾逗号、单引号、注释、未引号 key
// 优先用原生 JSON.parse(严格),失败后走容错路径

export function tolerantParse(text: string): unknown {
  // 先试严格解析
  try {
    return JSON.parse(text)
  } catch {
    /* 继续容错 */
  }
  // 容错:清理后再解析
  const cleaned = cleanup(text)
  return JSON.parse(cleaned)
}

/** 容错清理:返回尽可能合法的 JSON 字符串 */
function cleanup(text: string): string {
  let s = text
  // 去单行注释
  s = s.replace(/\/\/[^\n\r]*/g, '')
  // 去多行注释
  s = s.replace(/\/\*[\s\S]*?\*\//g, '')
  // 单引号字符串 → 双引号(简单处理:不在嵌套场景过度复杂)
  s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => {
    return '"' + inner.replace(/"/g, '\\"').replace(/\\'/g, "'") + '"'
  })
  // 未引号的 key: { key: } → { "key": }
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, (_m, pre, key, post) => {
    return `${pre}"${key}"${post}`
  })
  // 去尾逗号
  s = s.replace(/,\s*([}\]])/g, '$1')
  return s
}

/** 提取错误位置信息(用于高亮) */
export function parseError(text: string): { message: string; position: number } | null {
  try {
    JSON.parse(text)
    return null
  } catch (e) {
    const msg = (e as Error).message
    const posMatch = msg.match(/position (\d+)/)
    return { message: msg, position: posMatch ? Number(posMatch[1]) : -1 }
  }
}

/**
 * 智能修复 JSON:尝试多种修复策略,返回可解析的结果。
 * 策略:cleanup(单引号/注释/尾逗号/未引号 key) → 去控制字符 → 修 True/False/None → 补全括号。
 * 成功返回 { ok: true, result },失败 { ok: false, error }。
 */
export function repairJson(text: string): { ok: boolean; result?: string; error?: string } {
  try {
    // 1. 先试原样解析(可能本来就合法)
    try {
      JSON.parse(text)
      return { ok: true, result: text }
    } catch {
      /* 继续修复 */
    }
    // 2. cleanup 基础修复
    let s = cleanup(text)
    // 3. 去除控制字符(\x00-\x1F,保留 \t \n \r)
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    // 4. 修 True/False/None(Python 风格 → JSON)
    s = s.replace(/\b(True)\b/g, 'true').replace(/\b(False)\b/g, 'false').replace(/\b(None)\b/g, 'null')
    // 5. 试解析
    try {
      JSON.parse(s)
      return { ok: true, result: s }
    } catch {
      /* 继续补括号 */
    }
    // 6. 智能补全未闭合的 } ]
    s = balanceBrackets(s)
    try {
      JSON.parse(s)
      return { ok: true, result: s }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 统计 { } [ ] 的未闭合数量,在末尾补全缺失的闭合符 */
function balanceBrackets(s: string): string {
  let braces = 0 // {}
  let brackets = 0 // []
  let inStr = false
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (escape) { escape = false; continue }
    if (c === '\\') { escape = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') braces++
    else if (c === '}') braces--
    else if (c === '[') brackets++
    else if (c === ']') brackets--
  }
  let tail = ''
  for (let i = 0; i < Math.max(0, brackets); i++) tail += ']'
  for (let i = 0; i < Math.max(0, braces); i++) tail += '}'
  return s + tail
}
