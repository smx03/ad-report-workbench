# 广告日报自动化工作台

一个可配置的广告日报生成工具。上传日报日、前一日和七日前三份Excel后，系统会校验账户范围、关联账户分类、聚合指标并生成两张日报和汇报文案。

## 公开仓库说明

本仓库是脱敏后的通用版本，不包含：

- 客户、公司或项目名称
- 真实账户ID、账户名称和Excel数据
- 真实渠道映射与账户纳入/排除规则
- 真实折扣参数
- SQLite分类库和日报历史

公开源码只包含通用计算引擎。`config/report-rules.example.json` 使用模拟业务、模拟渠道和模拟参数，用于测试与二次开发。

## 如何运行真实业务数据

真实规则通过私密环境变量注入，不需要写入公开仓库：

1. 在本机保存真实规则JSON，确认该文件不在Git仓库目录内。
2. 将文件编码为单行Base64：

   ```bash
   base64 < /安全目录/report-rules.private.json | tr -d '\n'
   ```

3. 把输出内容保存到部署平台的私密环境变量 `REPORT_CONFIG_BASE64`。
4. 设置 `REQUIRE_PRIVATE_CONFIG=true`，防止服务器误用模拟规则启动。
5. 部署后登录网站，在页面中导入最新版账户分类表。

规则配置决定字段表头、折扣参数、设备归一化、账户分类、输出行结构和日报文案。真实Excel和分类表仍只在运行时使用，不会进入GitHub。

## GitHub与Render部署

项目包含Node.js服务和SQLite，因此不能部署到GitHub Pages。推荐流程：

1. 将本目录提交到GitHub公有仓库。
2. 在Render选择 `New > Blueprint` 并连接仓库。
3. Render读取 `render.yaml`，创建Docker服务和1GB持久化磁盘。
4. 按提示填写 `REPORT_CONFIG_BASE64`。
5. 部署后查看Render自动生成的 `APP_PASSWORD`。
6. 使用用户名 `admin` 和该密码访问网站。
7. 首次进入后导入最新版账户分类表。

`render.yaml` 使用Starter实例，因为SQLite需要持久化磁盘。没有持久化磁盘的临时实例在重新部署后可能丢失分类库。

## 本地运行

需要Node.js 24及以上版本：

```bash
corepack enable
pnpm install --frozen-lockfile
APP_PASSWORD='替换为安全密码' pnpm start
```

默认使用模拟规则，打开 `http://127.0.0.1:4319/`。

加载本机私密规则：

```bash
REPORT_CONFIG_PATH='/安全目录/report-rules.private.json' \
APP_PASSWORD='替换为安全密码' \
pnpm start
```

使用Docker：

```bash
APP_PASSWORD='替换为安全密码' docker compose up --build
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `APP_PASSWORD` | 生产必填 | 无 | 网站访问密码，建议至少16位随机字符 |
| `APP_USERNAME` | 否 | `admin` | 网站访问用户名 |
| `REPORT_CONFIG_BASE64` | 真实部署必填 | 无 | Base64编码后的私密规则JSON |
| `REPORT_CONFIG_JSON` | 否 | 无 | 直接传入私密规则JSON |
| `REPORT_CONFIG_PATH` | 本机可选 | 示例规则 | 本机私密规则文件路径 |
| `REQUIRE_PRIVATE_CONFIG` | 线上建议 | `false` | 为`true`时，缺少私密规则将拒绝启动 |
| `DATA_DIR` | 否 | `./data` | SQLite和日报历史的持久化目录 |
| `PORT` | 否 | `4319` | 服务端口 |
| `MAX_REQUEST_MB` | 否 | `20` | 单次请求最大体积 |

## 数据安全

- Excel在服务器内存中解析，不落盘保存。
- SQLite和历史数据只写入 `DATA_DIR`。
- 页面和API使用HTTP Basic Auth保护。
- `.gitignore`会排除数据库、私密配置、环境变量和本地运行数据。
- 不要把真实规则、Excel、截图或数据库提交到Git历史。

## 测试

```bash
pnpm test
```

GitHub Actions会自动执行脱敏模拟测试并构建Docker镜像。
