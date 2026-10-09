# 网站部署

有度支持在已有网站的目录下运行。静态资源、模块和 API 使用相对路径，目录入口应带尾部斜杠。

## 配置

```sh
PORT=8318
ALLOCATION_PUBLIC_ORIGIN=https://example.com
ALLOCATION_BASE_PATH=/finance/allocation/
ALLOCATION_AUTH_URL=https://example.com/tools/api/auth/check
ALLOCATION_DAILY_REQUEST_LIMIT=100
ALLOCATION_QUOTA_FILE=/path/to/private/question-quota.json
```

生产入口的 Origin 使用明确配置的 HTTPS 来源。认证接口与网站同源，返回 `{"authenticated":true}` 才允许请求；认证服务故障时请求停止。网页沿用网站登录，匿名页面转向 `/login`，API 返回 401。

认证请求只转发 `hanako_session` 与 `links_session`，需要网站本身提供该 Cookie 验证接口。模型密钥和原文资料留在运行机器，认证 Cookie 不写入日志或提供给模型。

问答限制为全服务并发 2、每分钟 12 次、每 UTC 日 100 次，可通过配置调整日额度。日计数写入私有额度文件，跨服务重启保留；额度文件损坏或写入失败时停止问答。该文件只含日期和计数。每份额度文件由一个应用实例独占；当前部署为单个固定端口与一个保活服务。多实例应使用各自额度文件，或另行实现统一额度存储。

## 当前部署结构

`https://0f4c81.top/finance/allocation/` 由专用 Nginx 路径转发，经回环 SSH 隧道连接 Mac 上的独立服务。Mac 的应用服务与隧道分别由专用 LaunchAgent 保活；原文检索与 DeepSeek 配置由应用服务加载。

应用发布到独立的版本目录，通过 `current` 软链接选择运行版本。更新时先验证测试与配置，再切换版本并重启本应用。回滚时恢复先前版本的软链接及对应配置；Nginx 路径有独立配置片段及修改前备份。

## 验收

- 匿名页面进入登录页；匿名 API 和模块不能返回应用资料。
- 网站会话可以加载所有资源，填写、计算、调整、导入导出可用。
- 同源问题可以完成原文检索与 DeepSeek 回答；跨站 Origin 被拒绝。
- 每日额度跨重启保留，超额请求在模型调用前停止。
- 原有网站页面和服务仍按既有路径工作。

实时上线结果与源版本记录保留在部署工作区；本文描述部署方式。
