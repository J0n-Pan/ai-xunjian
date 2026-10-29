// 数据目录解析 —— 程序目录可以整体替换，数据目录必须稳定。
//
// 为什么单独有这一层：免安装包的升级方式是「解压出一个新文件夹」，如果 episodes / uploads / .env
// 还留在程序目录里，换版本就等于换数据（用户的工程全不见了）。所以从 v1.1 起，这些运行时数据
// 统一放进一个固定的数据目录，程序怎么换都指向同一个地方。
//
// 解析顺序（先命中先用）：
//   1. XUNJIAN_HOME                     显式指定（服务器部署、自动化测试）
//   2. <程序>/data                      便携模式：程序与数据同目录，整个文件夹拷走即可
//   3. <程序>/episodes 或 <程序>/.git   源码仓库 / v1.0.x 老布局，数据本来就在程序目录里
//   4. %LOCALAPPDATA%\AI初剪工作台\home.txt 里记着的数据目录
//      —— 新包装到别的盘/别的文件夹也能找回同一份数据，靠的就是这个指针
//   5. <程序同级>/AI初剪工作台-数据      默认值：与程序同一块盘，不占系统盘
//      不可写（比如解压到了 Program Files）时用 %LOCALAPPDATA%\AI初剪工作台
//
// 注意：结果必须稳定。服务端第一次启动时数据目录还是空的，不能因为「episodes 不存在」
// 下一轮就改判到别处，所以 homeOf() 做了进程内缓存。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const HOME_DIR_NAME = "AI初剪工作台-数据";

function usable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function baseDir() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "AI初剪工作台");
}

function readPointer(base) {
  try {
    return String(fs.readFileSync(path.join(base, "home.txt"), "utf8")).trim();
  } catch {
    return "";
  }
}

function writePointer(base, target) {
  try {
    fs.mkdirSync(base, { recursive: true });
    const f = path.join(base, "home.txt");
    if (readPointer(base) !== target) fs.writeFileSync(f, target + "\n");
  } catch {
    /* 记不住就算了，下次按默认规则再算一遍 */
  }
}

export function resolveHome(appRoot) {
  const root = path.resolve(appRoot);

  const env = String(process.env.XUNJIAN_HOME || "").trim();
  if (env) {
    const p = path.resolve(env);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  const inline = path.join(root, "data");
  if (fs.existsSync(inline)) return inline;

  // 源码仓库（.git）和 v1.0.x 的免安装包（episodes 就在程序目录）继续沿用程序目录，
  // 否则开发时打开剪辑台会看到一个空工程列表，老用户升级前的数据也会瞬间「消失」。
  if (fs.existsSync(path.join(root, "episodes")) || fs.existsSync(path.join(root, ".git"))) return root;

  const base = baseDir();

  // 之前用过哪个数据目录就继续用它 —— 新版本解压到别的盘也认得住。
  // 记着的位置已经不存在（被删/被移走）时不要凭空建一个空的，按默认规则重算。
  const pointed = readPointer(base);
  if (pointed && fs.existsSync(pointed) && usable(pointed)) return path.resolve(pointed);

  const sibling = path.join(path.dirname(root), HOME_DIR_NAME);
  if (usable(sibling)) {
    writePointer(base, sibling);
    return sibling;
  }

  if (usable(base)) {
    writePointer(base, base);
    return base;
  }
  fs.mkdirSync(base, { recursive: true });
  return base;
}

const cache = new Map();

export function homeOf(appRoot) {
  const key = path.resolve(appRoot);
  if (!cache.has(key)) cache.set(key, resolveHome(key));
  return cache.get(key);
}

// 数据目录下的固定成员（升级搬迁、文档、诊断都用这一份清单）
export const HOME_DIRS = ["episodes", "uploads", "exports"];
export const HOME_FILES = [".env"];
