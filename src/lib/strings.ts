/**
 * Default UI copy for the kit. Projects with i18n call configureStrings()
 * once at boot with their translations; components read through s().
 * Keep copy short: verbs on buttons, no "确定" / "提交".
 */
const zh = {
  close: "关闭",
  cancel: "取消",
  retry: "重试",
  undo: "撤销",
  required: "必填",
  moreInfo: "说明",
  discardTitle: "放弃未保存的修改？",
  discardBody: "关闭后，刚才的修改不会保留。",
  discardConfirm: "放弃修改",
  discardKeep: "继续编辑",
  selectPlaceholder: "请选择",
  searchPlaceholder: "搜索",
  noOptions: "没有匹配的选项",
  emptyTitle: "还没有内容",
  noMatchTitle: "没有符合条件的结果",
  noMatchAction: "清除筛选",
  noPermissionTitle: "你没有查看权限",
  noPermissionBody: "需要权限时，请联系管理员。",
  errorTitle: "加载失败",
  errorBody: "请检查网络后重试。",
  selectedCount: (n: number) => `已选 ${n} 项`,
  clearSelection: "取消选择",
  totalCount: (n: number) => `共 ${n} 条`,
  pageOf: (p: number, total: number) => `${p} / ${total}`,
  perPage: (n: number) => `${n} 条/页`,
  prevPage: "上一页",
  nextPage: "下一页",
  rowActions: "更多操作",
  all: "全部",
  yes: "是",
  no: "否",
  clear: "清除",
  unsaved: "有未保存的修改",
  save: "保存",
  discard: "放弃",
  saved: "已保存",
  openMenu: "打开菜单",
  collapseSidebar: "收起侧边栏",
  expandSidebar: "展开侧边栏",
  back: "返回",
  resizePanel: "调整宽度",
  filters: "筛选",
  andMore: (n: number) => ` 等 ${n} 项`,
  commandPlaceholder: "搜索或输入命令",
  commandEmpty: "没有匹配的结果",
  commandNavigate: "选择",
  commandRun: "打开",
  uploadTitle: "上传",
  uploadProgress: (done: number, total: number) => `上传中 · ${done}/${total}`,
  uploadSummary: (added: number, exists: number, failed: number) =>
    [added && `已添加 ${added} 个`, exists && `已存在 ${exists} 个`, failed && `失败 ${failed} 个`].filter(Boolean).join("，"),
  uploadWaiting: "等待",
  uploadUploading: "上传中",
  uploadPercent: (p: number) => `上传中 ${p}%`,
  uploadAdded: "已添加",
  uploadExists: "已存在",
  uploadFailed: "失败",
  collapse: "收起",
  expand: "展开",
}

export type Strings = typeof zh
let current: Strings = zh

export function configureStrings(partial: Partial<Strings>) {
  current = { ...current, ...partial }
}

export function s(): Strings {
  return current
}
