/** 「数据脱敏」设置页文案（zh/en）。 */
export type RedactKey =
  | 'nav'
  | 'loading'
  | 'statusError'
  | 'save'
  | 'saved'
  | 'saveFailed'
  | 'discard'
  | 'dirty'
  | 'switchesTitle'
  | 'maskLlm'
  | 'maskLlmHint'
  | 'restoreOutput'
  | 'restoreOutputHint'
  | 'maskLogs'
  | 'maskLogsHint'
  | 'categoriesTitle'
  | 'catSecret'
  | 'catId'
  | 'catBank'
  | 'catPhone'
  | 'catEmail'
  | 'catSecretHint'
  | 'catIdHint'
  | 'catBankHint'
  | 'catPhoneHint'
  | 'catEmailHint'
  | 'rulesTitle'
  | 'ruleName'
  | 'rulePattern'
  | 'ruleAdd'
  | 'ruleDelete'
  | 'ruleEmpty'
  | 'statsTitle'
  | 'statCount'
  | 'statLastAt'
  | 'statNone'
  | 'sessionsCount'
  | 'clearMaps'
  | 'clearMapsDone'
  | 'testTitle'
  | 'testPlaceholder'
  | 'testRun'
  | 'testResult'
  | 'ruleErrors'

export const zh: Record<RedactKey, string> = {
  nav: '数据脱敏',
  loading: '加载中…',
  statusError: '配置获取失败',
  save: '保存',
  saved: '已保存并生效',
  saveFailed: '保存失败',
  discard: '放弃更改',
  dirty: '有未保存更改',
  switchesTitle: '开关',
  maskLlm: '发往 LLM 的消息脱敏',
  maskLlmHint: '用户输入与工具结果在发出前替换为占位符（如 [[TEL_1]]），模型厂商收不到真实值',
  restoreOutput: '模型输出中的占位符还原',
  restoreOutputHint: '模型回复、工具调用参数中的占位符在展示与执行前还原为真实值',
  maskLogs: '日志打码',
  maskLogsHint: '宿主日志输出中的敏感内容同样替换（只打码，不还原）',
  categoriesTitle: '内置类别',
  catSecret: '密钥/凭据',
  catSecretHint: 'sk-…、AKIA…、ghp_…、JWT、Bearer、私钥块、password=… 等',
  catId: '身份证号',
  catIdHint: '18 位（校验码验证）/15 位一代证',
  catBank: '银行卡号',
  catBankHint: '13–19 位且通过 Luhn 校验',
  catPhone: '手机号',
  catPhoneHint: '1[3-9] 开头的 11 位号段',
  catEmail: '邮箱',
  catEmailHint: '标准邮箱地址',
  rulesTitle: '自定义规则（正则，命中即脱敏）',
  ruleName: '名称',
  rulePattern: '正则',
  ruleAdd: '添加规则',
  ruleDelete: '删除',
  ruleEmpty: '暂无自定义规则',
  statsTitle: '命中统计（累计）',
  statCount: '命中',
  statLastAt: '最近',
  statNone: '尚无命中',
  sessionsCount: '会话映射：{n}',
  clearMaps: '清空会话映射',
  clearMapsDone: '已清空',
  testTitle: '脱敏测试',
  testPlaceholder: '粘贴一段含敏感信息的文本，看脱敏效果…',
  testRun: '测试',
  testResult: '结果',
  ruleErrors: '规则警告',
}

export const en: Record<RedactKey, string> = {
  nav: 'Data Redaction',
  loading: 'Loading…',
  statusError: 'Failed to load config',
  save: 'Save',
  saved: 'Saved and applied',
  saveFailed: 'Save failed',
  discard: 'Discard changes',
  dirty: 'Unsaved changes',
  switchesTitle: 'Switches',
  maskLlm: 'Mask outbound LLM messages',
  maskLlmHint: 'User input and tool results are replaced with placeholders (e.g. [[TEL_1]]) before leaving; providers never see real values',
  restoreOutput: 'Restore placeholders in model output',
  restoreOutputHint: 'Placeholders in replies and tool-call arguments are restored to real values before display/execution',
  maskLogs: 'Mask logs',
  maskLogsHint: 'Sensitive content in host logs is masked the same way (one-way, no restore)',
  categoriesTitle: 'Built-in categories',
  catSecret: 'Secrets / credentials',
  catSecretHint: 'sk-…, AKIA…, ghp_…, JWT, Bearer, private key blocks, password=…',
  catId: 'ID numbers',
  catIdHint: '18-digit (checksum verified) / 15-digit legacy',
  catBank: 'Bank cards',
  catBankHint: '13–19 digits passing Luhn',
  catPhone: 'Phone numbers',
  catPhoneHint: '11-digit 1[3-9] segments',
  catEmail: 'Emails',
  catEmailHint: 'Standard email addresses',
  rulesTitle: 'Custom rules (regex; matches are masked)',
  ruleName: 'Name',
  rulePattern: 'Pattern',
  ruleAdd: 'Add rule',
  ruleDelete: 'Delete',
  ruleEmpty: 'No custom rules yet',
  statsTitle: 'Hit statistics (cumulative)',
  statCount: 'Hits',
  statLastAt: 'Last at',
  statNone: 'No hits yet',
  sessionsCount: 'Session maps: {n}',
  clearMaps: 'Clear session maps',
  clearMapsDone: 'Cleared',
  testTitle: 'Redaction test',
  testPlaceholder: 'Paste text containing sensitive info to see the masking…',
  testRun: 'Test',
  testResult: 'Result',
  ruleErrors: 'Rule warnings',
}
