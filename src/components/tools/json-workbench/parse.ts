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
