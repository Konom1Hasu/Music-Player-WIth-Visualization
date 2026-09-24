// 档案数据层：由播放器（音乐库）动态填充，取代原来的静态 archives.json。
// 歌曲被映射成 ArchiveRecord 后，三维档案阵列 / 检索 / 收藏 全部照常工作。
export interface ArchiveRecord {
  id: string;
  title: string;
  en: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  abstract: string;
  findings: string[];
  source: string;
}

export let archiveColumns: string[] = ["音乐 Ⅰ", "音乐 Ⅱ", "音乐 Ⅲ", "音乐 Ⅳ", "音乐 Ⅴ"];
/* ★ records 从第一行代码起就不能为空：main.ts 在模块加载期就会调用 updateSelection()
   读取 records[selected]，空数组会让它在 start() 之前抛错，开屏直接卡在加载层。 */
export let records: ArchiveRecord[] = [placeholderRecord(archiveColumns[0])];
export const categories = ["全部音乐"];

const changeListeners: (() => void)[] = [];
export function onRecordsChange(fn: () => void) {
  changeListeners.push(fn);
}
export function setRecords(next: ArchiveRecord[], columns: string[]) {
  records = next.length ? next : [placeholderRecord(columns[0] || "音乐 Ⅰ")];
  archiveColumns = columns.length ? columns : ["音乐档案"];
  changeListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}

/* 音乐库为空时的占位档案：让三维阵列始终有内容可显示，选中它提示去导入。 */
function placeholderRecord(category: string): ArchiveRecord {
  return {
    id: "X-000",
    title: "导入音乐",
    en: "IMPORT MUSIC",
    department: "文件夹 / NCM / B站缓存",
    category,
    date: "EMPTY LIBRARY",
    lead: "点击播放条左侧 ＋ 导入",
    clearance: "AUTHORIZED",
    abstract: "音乐库为空。点击播放条左侧的 ＋ 选择音频文件，也可以把本地音乐文件夹直接拖进窗口。",
    findings: [],
    source: "",
  };
}

export function columnFiles(lane: number) {
  const laneName = archiveColumns[((Math.abs(lane) % archiveColumns.length) + archiveColumns.length) % archiveColumns.length];
  let files = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.category === laneName)
    .map(({ index }) => index);
  // 某列没有任何歌曲时回退为全部歌曲，避免三维阵列拿到空列表而崩掉。
  if (!files.length) files = records.map((_, index) => index);
  return files;
}
export function fileLocation(index: number) {
  const cat = records[index]?.category ?? archiveColumns[0];
  let lane = archiveColumns.indexOf(cat);
  if (lane < 0) lane = 0;
  const row = 12 + columnFiles(lane).indexOf(index);
  return { lane, row, slot: lane * 32 + row };
}
export function fileAtSlot(slot: number) {
  const lane = Math.floor(slot / 32) % archiveColumns.length;
  const files = columnFiles(lane);
  return files[Math.max(0, Math.min(files.length - 1, (slot % 32) - 12))];
}
