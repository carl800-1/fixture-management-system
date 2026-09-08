# 工装夹具出入库管理系统

独立运行的夹具管理程序，支持夹具出库 / 回库 / 维修的重复流转。

## 版本
**v2.1**（2026-09-08）— 详见 [修改日志.md](./修改日志.md)

> v1.2 修复了「窗口只剩标题框、无法关闭也无法切换」的致命问题（Chromium 沙箱导致 GPU 进程崩溃），
> v1.3 修复了「启动后弹出空白标题模态框」，
> v1.4 新增出库/回库四栏互查、二维码前缀兼容与中文输入法守卫，
> v1.5 界面风格与备件仓库管理系统对齐：移除底部状态栏，侧边栏底部署名 `design by Frank, 2026.7`，
> 「关于 / About」改为右下角蓝色浮动胶囊按钮，面板采用「变更日记」滚动结构。
> v1.6 新增「库位管理」模块（10 列网格总览 + 点击筛选 + 手工盘点 CSV 导出）与编号归一化匹配。
> v1.7 新增夹具二维码标签生成与打印（单个/批量，纸张尺寸/对齐/边距/份数 + 实时预览）。
> v1.8 新增夹具列表「卡片 / 列表」视图切换，并补齐表格样式、修复维修完成按钮类名。
> v1.9 关于面板「变更日记」的版本标题去掉日期后缀（仅显示 v1.9），并同步 GitHub 最新改动。

## 目录结构
```
fixtures/v1.0/
├── package.json        # 项目配置
├── main.js             # Electron 主进程
├── preload.js          # 安全桥接
├── store.js            # 数据层（Node fs，主进程侧）
├── index.html          # 主页面
├── css/
│   └── style.css       # 样式
├── js/
│   ├── app.js          # 业务逻辑
│   ├── db.js           # 数据层接口（渲染进程侧）
│   ├── pinyin-match.js # 拼音匹配
│   └── vendor/
│       ├── jsQR.js     # 二维码解码
│       └── qrcode-generator.js  # 二维码生成
├── test_store.js       # 数据层功能测试（Node）
├── test_render.js      # 渲染层静态检查（Node）
├── test_e2e.js         # 真实运行测试（Electron）
├── 修改日志.md          # 版本变更记录
└── README.md           # 本文件
```

## 核心功能
1. **夹具管理**：建档（4 位数字编号）、搜索、导出 CSV、卡片/列表视图切换
2. **出库流程**：编号/名称/规格/库位四栏互查 → 经办人 / 领用人 → 确认出库
3. **回库流程**：编号/名称/规格/库位四栏互查 → 经办人 → 确认回库
4. **送修流程**：选择夹具 → 经办人 / 维修类型（普通维修·校准·更换配件·保养）→ 确认送修
5. **维修完成**：维修中夹具 → 经办人 → 确认完成并回库
6. **报废流程**：经办人 / 报废原因 → 确认报废（终态，禁止再出库）
7. **扫码**：出库 / 回库扫码，批量扫码连续出库
8. **流水记录**：完整状态流转轨迹，可按编号 / 名称 / 经办人搜索（支持 SPMS1| 二维码前缀）
9. **库位管理**：10 列网格库位总览（三行可视、滚动浏览）、点击筛选夹具明细、手工盘点 CSV 导出
10. **二维码标签**：单夹具二维码查看/下载 PNG，单个/批量打印标签（纸张尺寸/对齐/边距/份数 + 实时预览）
11. **数据备份**：导出 JSON、清空数据（真正落盘）

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

| type          | from → to                   | 说明                     |
|---------------|-----------------------------|--------------------------|
| `out`         | stocked → checked_out       | 出库计数 +1              |
| `return`      | checked_out → stocked       | 回库计数 +1              |
| `repair`      | stocked/checked_out → repair| 维修计数 +1              |
| `repair_done` | repair → stocked            | v1.1 新增，维修完成回库  |
| `retire`      | 任意非 retired → retired    | 终态                     |

## 数据模型
- `fixtures`：夹具主表（code / name / spec / category / location / status / totalOutCount / totalReturnCount / repairCount / qrToken）
- `fixTransactions`：流水表（fixtureCode / type / operator / counterparty / remark / repairType / fromStatus → toStatus / time）
- 数据文件：`fixture-data.json`，位于 **exe 同目录**（打包模式）

## 自动化测试

三套测试，共 **149 项**，全部通过：

```bash
cd fixtures/v1.0

# 1. 数据层功能测试（53 项）— 纯 Node，无需 Electron
node test_store.js

# 2. 渲染层静态检查（34 项）— 纯 Node，含 7 处版本号一致性校验
node test_render.js

# 3. 真实运行测试（62 项）— 启动真实 Electron 窗口驱动 UI
#    ⚠️ 必须先清除 ELECTRON_RUN_AS_NODE，否则 Electron 会退化成 Node
unset ELECTRON_RUN_AS_NODE
<electron.exe> test_e2e.js
```

`test_e2e.js` 会自动：
- 将 `userData` 指向系统临时目录，绝不污染真实数据
- 禁用硬件加速（无 GPU 环境也能跑）
- 捕获所有 `console.error` 与页面加载失败
- 驱动完整业务流：建档 → 出库 → 回库 → 3 轮循环 → 送修 → 维修完成 → 报废 → 搜索 → 清空 → 重启验证

## 启动方式
```bash
cd fixtures/v1.0
npm install
npm start
```

## 构建
```bash
# 在构建目录（fixtures_v1_build）执行，需先同步源码
unset ELECTRON_RUN_AS_NODE
export NODE_OPTIONS=         # 必须清空，否则注入的 shim 会让构建卡死
npx electron-builder --win
```

构建要点：
- `asar: false` — 规避 asar 内路径分隔符问题
- `nodeGypRebuild: false` / `npmRebuild: false` — 离线环境无需重建原生模块
- `electronDist` 指向本地 Electron，跳过联网下载
- 输出目录若被 Windows 索引 / Defender 锁定，改用全新目录名
- **CSS 必须位于 `css/style.css`**（index.html 引用路径），放根目录会导致程序无样式

## 发布目录

输出根目录固定为 **`D:\project\fixture`**（`directories.output`），每个版本一个子文件夹：

```
D:\project\fixture\
├── v1.1\                 ← 版本子文件夹（以版本号命名）
│   ├── 工装夹具出入库管理系统.exe    ← 双击直接运行
│   ├── *.dll / locales\ / resources\ ...
│   └── fixture-data.json  ← 运行后自动生成，数据同目录落盘
└── v1.2\  v1.3\  v1.4\  v1.5\  v1.6\  v1.7\  v1.8\  v1.9\ ...  ← 后续版本依次创建
```

发布步骤（升版时）：
1. 改源码 + 同步版本号标记（见 `修改日志.md` 顶部规则）
2. 构建后 `D:\project\fixture\` 下会生成 `win-unpacked`
3. 将 `win-unpacked` **重命名**为 `v<两位版本号>`（如 `v1.2`）
4. 若需保留旧数据，把上一版本的 `fixture-data.json` 复制进新版本目录
