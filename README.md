# 夹具管理系统 Fixture Management System

> 夹具出入库管理桌面程序 · Electron + 原生 JS · 本地 JSON 存储 · 无需联网

一个独立运行的夹具（治具）出入库管理工具，覆盖夹具从**建档 → 出库 → 回库 → 送修 → 维修完成 → 报废**的全生命周期流转，
支持库位管理、二维码标签打印与完整流水追溯。数据与程序同目录落盘，单机使用，不依赖任何服务器或数据库。

姊妹项目：[备件仓库管理系统 SPMS](https://github.com/carl800-1/spms)

---

## 界面预览

| 模块 | 说明 |
|------|------|
| 🏠 仪表盘 | 在库 / 已出库 / 维修中 / 已报废统计概览 |
| 📦 夹具管理 | 建档、搜索、编辑、导出 CSV、**卡片 / 列表视图切换** |
| 📤 夹具出库 | 四栏互查选件 → 经办人 / 领用人 → 出库 |
| 📥 夹具回库 | 四栏互查选件 → 经办人 → 回库 |
| 🗺️ 库位管理 | 10 列网格总览、点击筛选、手工盘点 CSV 导出 |
| 🔍 流水记录 | 全量状态流转轨迹，支持二维码前缀搜索 |
| 💾 数据备份 | 导出 JSON、清空数据（真正落盘） |

---

## 核心功能

1. **夹具管理**：建档（4 位数字编号，如 `1001`）、搜索、导出 CSV、卡片 / 列表两种视图
2. **出库 / 回库**：编号 / 名称 / 规格 / 库位 **四栏交叉互查**，命中唯一自动回填，多命中列候选
3. **送修 / 维修完成 / 报废**：维修类型（普通维修 · 校准 · 更换配件 · 保养）；报废为终态
4. **扫码支持**：出库 / 回库扫码，支持批量扫码连续出库
5. **二维码标签**：单夹具二维码查看 / 下载 PNG，单个 & 批量打印标签
   （纸张 A4 / A5 / 小票 58 / 80、标签 100×150、自定义，含对齐 / 边距 / 份数与实时预览）
6. **库位管理**：10 列网格总览（三行可视、纵向滚动）、点击筛选明细、手工盘点导出 CSV
7. **编号归一化匹配**：忽略大小写 / 连字符 / 下划线 / 空格，兼容 `SPMS1|<code>` 二维码前缀
8. **中文输入法守卫**：组合输入期间不误触发搜索
9. **流水追溯**：完整记录每次状态流转的时间、经办人、对方与备注

---

## 状态机

```
                  出库 out              回库 return
  stocked(在库) ──────────→ checked_out(已出库) ──────────→ stocked
       │                                                       ↑
       │ 送修 repair                          维修完成 repair_done
       ↓                                                       │
    repair(维修中) ────────────────────────────────────────────┘
       │
       │ 报废 retire
       ↓
   retired(已报废) ── 终结状态 ──
```

| type          | from → to                    | 说明                  |
|---------------|------------------------------|-----------------------|
| `out`         | stocked → checked_out        | 出库计数 +1           |
| `return`      | checked_out → stocked        | 回库计数 +1           |
| `repair`      | stocked / checked_out → repair | 维修计数 +1         |
| `repair_done` | repair → stocked             | 维修完成回库          |
| `retire`      | 任意非 retired → retired     | 终态，禁止再出库      |

---

## 数据模型

- `fixtures`：夹具主表
  （`code` / `name` / `spec` / `category` / `location` / `status` / `totalOutCount` / `totalReturnCount` / `repairCount` / `qrToken`）
- `fixTransactions`：流水表
  （`fixtureCode` / `type` / `operator` / `counterparty` / `remark` / `repairType` / `fromStatus` → `toStatus` / `time`）

数据文件 `fixture-data.json` 位于 **exe 同目录**（打包模式），开发模式下位于 Electron `userData` 目录。

---

## 快速开始

```bash
git clone https://github.com/carl800-1/fixture-management-system.git
cd fixture-management-system
npm install
npm start
```

> 需要 Node.js 16+。`npm install` 会自动安装 Electron 31。

## 构建（Windows）

```bash
npm run build
```

输出 `release/win-unpacked`，其中 `夹具管理系统.exe` 双击即可运行，数据与 exe 同目录。

构建要点：
- `asar: false` — 规避 asar 内路径分隔符问题
- 若输出目录被 Windows 索引 / Defender 锁定，改用全新目录名
- CSS 必须位于 `css/style.css`（`index.html` 按此路径引用），放错位置会导致程序无样式

---

## 自动化测试

仓库内置三套测试，共 **181 项**全部通过：

```bash
# 1. 数据层功能测试（56 项）— 纯 Node
node test_store.js

# 2. 渲染层静态检查（36 项）— 纯 Node，含 7 处版本号一致性校验
node test_render.js

# 3. 真实 UI 测试（89 项）— 启动真实 Electron 窗口驱动界面
#    ⚠️ 必须先清除 ELECTRON_RUN_AS_NODE，否则 Electron 会退化成 Node 模式
unset ELECTRON_RUN_AS_NODE          # Windows: set ELECTRON_RUN_AS_NODE=
npx electron test_e2e.js
```

`test_e2e.js` 会将 `userData` 指向系统临时目录（绝不污染真实数据），
并驱动完整业务流：建档 → 出库 → 回库 → 3 轮循环 → 送修 → 维修完成 → 报废 → 搜索 → 清空 → 重启验证。

---

## 目录结构

```
fixture-management-system/
├── package.json        # 项目配置
├── main.js             # Electron 主进程
├── preload.js          # 安全桥接（contextBridge）
├── store.js            # 数据层（Node fs，主进程侧）
├── index.html          # 主页面
├── css/
│   └── style.css       # 样式
├── js/
│   ├── app.js          # 业务逻辑与视图渲染
│   ├── db.js           # 数据层接口（渲染进程侧，经 IPC 桥接）
│   ├── pinyin-match.js # 拼音模糊匹配
│   └── vendor/
│       ├── jsQR.js               # 二维码解码（离线）
│       └── qrcode-generator.js   # 二维码生成（离线）
├── test_store.js       # 数据层测试
├── test_render.js      # 渲染层静态检查
├── test_e2e.js         # 真实 UI 测试
└── 修改日志.md          # 版本变更记录
```

---

## 版本与变更

当前版本 **v1.9**（2026-09-08）。完整变更历史见 [修改日志.md](./修改日志.md)。

| 版本 | 要点 |
|------|------|
| v1.9 | 关于面板「变更日记」版本标题去掉日期后缀（仅显示 v1.9） |
| v1.8 | 夹具列表「卡片 / 列表」视图切换；补齐表格样式；修复维修完成按钮主色 |
| v1.7 | 二维码标签生成与打印（单个 / 批量，纸张 / 对齐 / 边距 / 份数 + 实时预览） |
| v1.6 | 新增「库位管理」模块（10 列网格总览 + 筛选 + 手工盘点 CSV）、编号归一化匹配 |
| v1.5 | 界面风格与 SPMS 对齐：侧边栏署名、右下角蓝色浮动「关于 / About」 |
| v1.4 | 出库 / 回库四栏互查、二维码前缀兼容、中文输入法守卫、关于面板 |
| v1.3 | 修复「启动后弹出空白标题模态框」（`[hidden]` 被 `display:flex` 覆盖） |
| v1.2 | 修复「窗口只剩标题框、无法操作」（Chromium 沙箱致 GPU 崩溃） |
| v1.1 | 修复维修完成回库、清空数据落盘、原生弹窗改模态框 |

> 版本号规则：**两位版本号**（1.0、1.1、2.0 …），不使用三位补丁号。
> 每次修改递增版本号并同步 7 处版本标记，由 `test_render.js` 自动校验。

---

## 技术栈

- **Electron 31**（Chromium + Node），桌面端
- 原生 JavaScript / HTML / CSS，无前端框架
- Node `fs` + JSON 文件持久化，无数据库
- 二维码：`qrcode-generator`（生成）+ `jsQR`（解码），均本地内置，**离线可用**

---

## License

MIT © Frank
