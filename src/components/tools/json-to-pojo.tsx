import type { ToolProps } from './shared'
import { DualPane, CopyBtn, ActionBtn } from './shared'
import { tolerantParse } from './json-workbench/parse'

interface Field {
  name: string
  type: string
  isArray: boolean
  children?: Field[]
}

function inferType(val: unknown): Field {
  if (val === null) return { name: '', type: 'Object', isArray: false }
  if (Array.isArray(val)) {
    const first = val[0]
    const inner = first !== undefined ? inferType(first) : { name: '', type: 'Object', isArray: false }
    return { name: '', type: inner.type, isArray: true, children: inner.children }
  }
  switch (typeof val) {
    case 'string':
      return { name: '', type: 'String', isArray: false }
    case 'number':
      return { name: '', type: Number.isInteger(val) ? 'Integer' : 'Double', isArray: false }
    case 'boolean':
      return { name: '', type: 'Boolean', isArray: false }
    default: {
      // object
      const fields = Object.entries(val as Record<string, unknown>).map(([k, v]) => {
        const f = inferType(v)
        f.name = k
        return f
      })
      return { name: '', type: '', isArray: false, children: fields }
    }
  }
}

function className(name: string): string {
  // 大驼峰
  const pascal = name
    .replace(/[_\-\s]+(\w)/g, (_, c) => c.toUpperCase())
    .replace(/^(\w)/, (_, c) => c.toUpperCase())
  return pascal || 'Root'
}

function genPojo(field: Field, rootName: string, nested: string[] = []): string {
  if (field.children) {
    const cls = className(rootName)
    const inner = field.children.map((f) => {
      if (f.children && !f.isArray) {
        const subCls = className(f.name)
        nested.push(genPojo(f, subCls, nested))
        return `    private ${subCls} ${f.name};`
      }
      if (f.children && f.isArray) {
        const subCls = className(f.name)
        const innerField = { ...f, isArray: false }
        nested.push(genPojo(innerField, subCls, nested))
        return `    private List<${subCls}> ${f.name};`
      }
      const t = f.isArray ? `List<${f.type}>` : f.type
      return `    private ${t} ${f.name};`
    })
    return `public class ${cls} {
${inner.join('\n')}
}`
  }
  return ''
}

export default function JsonToPojo({ input, onInput }: ToolProps) {
  let pojo = ''
  let err = ''
  if (input.trim()) {
    try {
      const obj = tolerantParse(input)
      const root = inferType(obj)
      const nested: string[] = []
      const main = genPojo(root, 'Root', nested)
      pojo = [main, ...nested].join('\n\n')
    } catch (e) {
      err = (e as Error).message
    }
  }

  return (
    <DualPane
      inputLabel="输入 JSON"
      outputLabel={err ? '错误' : 'Java POJO'}
      input={input}
      onInput={onInput}
      inputPlaceholder='{"name":"test","age":18,"items":[{"id":1}]}'
      output={err || pojo}
      actions={
        <>
          <ActionBtn onClick={() => onInput('{"name":"test","age":18,"items":[{"id":1}]}')}>示例</ActionBtn>
          <CopyBtn text={pojo} label="复制 POJO" />
        </>
      }
    />
  )
}
