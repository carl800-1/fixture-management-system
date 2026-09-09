# 工装夹具出入库管理系统 v2.1（桌面版 / 独立 exe）

**v2.1 是一个打包好的桌面程序**（基于 Electron）。双击 `工装夹具出入库管理系统.exe` 即可使用，**无需安装、无需联网、无需浏览器**，所有数据保存在本机文件里。

> 系统覆盖夹具从建档、出库、回库、送修、维修完成到报废的全生命周期管理，并支持二维码标签、扫码作业、流水追溯与数据备份。

## 功能模块

| 模块 | 说明 |
| --- | --- |
| 仪表盘 | 夹具总数、在库 / 已出库 / 维修中 / 已报废统计；今日流水；最近动态 |
| 夹具管理 | 建档（4 位数字编号）、编辑、搜索、卡片/列表视图切换、CSV 导出；**v2.1 起支持关联最多 4 个机种名称** |
| 出库管理 | 编号 / 名称 / 机种名称 / 库位四栏互查 → 经办人 / 领用人 → 确认出库 |
| 回库管理 | 编号 / 名称 / 机种名称 / 库位四栏互查 → 经办人 → 确认回库 |
| 送修管理 | 在库或已出库夹具 → 选择维修类型（普通维修 / 校准 / 更换配件 / 保养）→ 确认送修 |
| 维修完成 | 维修中夹具 → 经办人确认 → 回库 |
| 报废管理 | 任意非报废夹具 → 填写报废原因 → 确认报废（终态，禁止再出库） |
| 库位管理 | 10 列网格库位总览、点击筛选夹具明细、手工盘点 CSV 导出 |
| 流水记录 | 完整状态流转轨迹，可按编号 / 名称 / 机种名称 / 经办人搜索 |
| 二维码标签 | 单夹具二维码预览/下载 PNG；单个/批量打印标签（纸张尺寸 / 对齐 / 边距 / 份数 + 实时预览） |
| 数据备份 | 导出全部数据为 JSON 备份；导入备份恢复；清空数据（危险） |

## 二维码功能（离线）

系统已内置二维码**生成**（`qrcode-generator`）与**解码**（`jsQR`）库到 `js/vendor/`，**完全离线、无需联网**。

- **编码规范**：二维码只承载夹具唯一编号，格式 `SPMS1|<编号>`（如 `SPMS1|2001`）。名称 / 机种名称等由系统按编号实时查库补全（原因：纯 ASCII 扫描最稳、码更小、且更名不影响旧码）。
- **生成标签**：「夹具管理」每行「二维码」可预览/下载单张 PNG；顶部「批量打印标签」可一次性生成全部在库夹具的标签（二维码 + 编号 / 名称 / 机种名称 / 库位文字），用系统打印到标签纸。
- **扫码作业**：「出库 / 回库」均提供扫码入口，识别后自动选中对应夹具，后续录入流程不变。
  - **上传图片识别**：对标签拍照后上传即可识别，**离线可用**，是 exe 内的主用方式。
  - **摄像头实时扫码**：受桌面环境安全上下文限制，exe 内默认隐藏摄像头入口、仅保留上传图片，不影响作业。

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

流水类型与状态迁移对照：

| type | from → to | 说明 |
| --- | --- | --- |
| `out` | stocked → checked_out | 出库计数 +1 |
| `return` | checked_out → stocked | 回库计数 +1 |
| `repair` | stocked/checked_out → repair | 维修计数 +1 |
| `repair_done` | repair → stocked | 维修完成回库 |
| `retire` | 任意非 retired → retired | 终态 |

## 数据说明（重要）

- v2.1 的数据保存在 **exe 同目录**下的 `fixture-data.json`：

  ```
  D:\project\fixture\v2.1\fixture-data.json
  ```

- 该文件是普通 JSON，**可直接整文件复制备份**；也可在程序内「数据备份」中导出/导入业务数据 JSON。
- 卸载或换电脑时，记得先「数据备份」导出，再在另一台机器「导入备份恢复」。
- **v2.1 数据模型升级**：夹具字段从单一 `spec` / `lineNo` 升级为 `lineModels: string[]`（最多 4 个机种名称）。首次启动时，旧数据中的 `spec`、`lineNo` 会自动迁移进 `lineModels`，无需手工处理。

## 文件结构（源码）

```
fixtures/v1.0/
├─ main.js                        Electron 主进程：创建窗口、注册 IPC
├─ preload.js                     渲染进程桥：contextBridge 暴露 window.api（安全）
├─ store.js                       主进程数据层：Node fs 写 fixture-data.json
├─ package.json                   electron-builder 配置
├─ index.html                     页面骨架（标题/品牌已标注 v2.1）
├─ css/style.css                  界面样式
├─ js/
│  ├─ db.js                       双模式数据层（Electron IPC / 浏览器回退）
│  ├─ app.js                      各功能模块逻辑、二维码/扫码/状态机
│  ├─ pinyin-match.js             拼音匹配（经办人联想）
│  └─ vendor/
│     ├─ qrcode-generator.js      离线二维码生成库（MIT）
│     └─ jsQR.js                  离线二维码解码库（MIT）
├─ test_store.js                  数据层功能测试（Node）
├─ test_render.js                 渲染层静态检查（Node，含版本号一致性校验）
├─ test_e2e.js                    真实运行测试（Electron）
├─ 修改日志.md                     版本变更记录
└─ README.md                      本文件
```

## 使用方法（exe）

1. 将 `工装夹具出入库管理系统.exe` 复制到你常用的任意位置（如桌面或 `D:\工具\`）。
2. **双击运行**即可，无需安装。首次启动为 1280×820 窗口，标题「工装夹具出入库管理系统 v2.1」。
3. 首次使用建议：在「夹具管理」点击 **新建夹具**，录入编号、名称及 1~4 个机种名称。
4. 日常通过「出库管理 / 回库管理」登记业务，状态自动变化；「流水记录」追溯历史并导出。
5. 仪表盘顶部会显示夹具统计与最近动态，确认系统已正常启动。

## 本地构建（开发/二次打包）

需要 Node.js 18+ 与 npm。在源码目录执行：

```bash
cd fixtures/v1.0

# 1) 安装依赖
npm install

# 2) 开发调试
npm start

# 3) 打包为独立 exe（产物在 release_v21/）
npm run build
```

构建完成后在 `release_v21/win-unpacked/` 得到完整程序目录，可重命名为 `v<版本号>` 使用。

### 受限网络 / 本机构建说明

- **构建前必须清空 `NODE_OPTIONS`**：WorkBuddy 沙箱垫片会在构建收尾删除时卡死。
  ```bash
  export NODE_OPTIONS=
  export CODEBUDDY_SESSION_ID=
  export CLAUDE_SESSION_ID=
  unset ELECTRON_RUN_AS_NODE
  ```
- **Windows Search / Defender 可能锁文件**：构建到全新输出目录（如 `release_v21`）规避，不要复用被锁的 `release/win-unpacked/`。
- **`asar: false`**：规避 asar 内路径分隔符问题。
- **`electronDist` 指向本地 Electron**，跳过联网下载。
- **CSS 必须位于 `css/style.css`**（`index.html` 引用路径），放根目录会导致程序无样式。

## 自动化测试

三套测试，共 **181 项**，全部通过：

```bash
cd fixtures/v1.0

# 1. 数据层功能测试（56 项）— 纯 Node，无需 Electron
node test_store.js

# 2. 渲染层静态检查（36 项）— 纯 Node，含 7 处版本号一致性校验
node test_render.js

# 3. 真实运行测试（89 项）— 启动真实 Electron 窗口驱动 UI
#    ⚠️ 必须先清除 ELECTRON_RUN_AS_NODE，否则 Electron 会退化成 Node
unset ELECTRON_RUN_AS_NODE
<electron.exe> test_e2e.js
```

`test_e2e.js` 会自动：
- 将 `userData` 指向系统临时目录，绝不污染真实数据
- 禁用硬件加速（无 GPU 环境也能跑）
- 捕获所有 `console.error` 与页面加载失败
- 驱动完整业务流：建档 → 出库 → 回库 → 多轮循环 → 送修 → 维修完成 → 报废 → 搜索 → 清空 → 重启验证

## 发布目录

输出根目录固定为 **`D:\project\fixture`**，每个版本一个子文件夹：

```
D:\project\fixture\
├── v2.1\                 ← 版本子文件夹（以版本号命名）
│   ├── 工装夹具出入库管理系统.exe    ← 双击直接运行
│   ├── *.dll / locales\ / resources\ ...
│   └── fixture-data.json             ← 运行后自动生成，数据同目录落盘
└── v1.9\  v2.0\ ...                  ← 旧版本保留可回滚
```

发布步骤（升版时）：
1. 改源码 + 同步版本号标记（见 `修改日志.md` 顶部规则）。
2. 构建后 `D:\project\fixture\` 下会生成 `win-unpacked`。
3. 将 `win-unpacked` **重命名**为 `v<两位版本号>`（如 `v2.1`）。
4. 若需保留旧数据，把上一版本的 `fixture-data.json` 复制进新版本目录。

## 常见问题

- **exe 启动后空白 / 点不了？** 正常不会。若异常，请将窗口内显示的红色错误提示发我；该程序已做全局兜底，任何 JS 错误都会显式渲染到页面而非白屏。
- **v2.1 打开后旧夹具的「规格型号」去哪了？** v2.1 起字段升级为「机种名称」，旧 `spec` / `lineNo` 会在首次启动时自动迁移进 `lineModels`，原数据不丢失。
- **导入 CSV 中文乱码？** 用 Excel 另存为 CSV（UTF-8）后导入；系统导出已带 UTF-8 BOM，Excel 可直接打开。
- **想多人共享 / 集中管理？** 当前为单机桌面版。如需多人集中访问，需要改为带后端（如 Node + 数据库）的版本。
- **数据存在哪、怎么备份？** 见上文「数据说明」。推荐定期在「数据备份」导出 JSON，或直接复制 `fixture-data.json`。
