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
}

export type Strings = typeof zh
let current: Strings = zh

export function configureStrings(partial: Partial<Strings>) {
  current = { ...current, ...partial }
}

export function s(): Strings {
  return current
}
