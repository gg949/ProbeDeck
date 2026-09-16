待办事项：
- [ ] setting.js SITE_FIELDS增加theme_url字段
- [ ] 后台主题商店选择主题以及版本，点击切换主题，保存到setting.js，格式为theme_url: 'https://github.com/huilang-me/CFSM-Theme-Store/tree/4e272b26193e35430261657b85e82c61d9dbf557/Tokinx/cf-server-monitor-theme-emerald/v1.0.10'，注意commitid以及版本号
- [ ] 前台根据setting.js中的theme_url字段，获取对应的github raw url(https://raw.githubusercontent.com/huilang-me/CFSM-Theme-Store/4e272b26193e35430261657b85e82c61d9dbf557/Tokinx/cf-server-monitor-theme-emerald/v1.0.10/index.html)，workers反代index.html以及assets目录下的所有文件，并且设置缓存时间为1小时
- [ ] 替换前端的index.html为workers反代的index.html，CSP和背景图，title注入等同样应用。注意仅代理index.html和assets目录，其他文件直接返回原有的文件
- [ ] 主题商店增加预览主题，在登录状态下，点击预览主题，跳转到?theme_url=theme_url,实现临时替换setting.js中的theme_url字段方案预览主题。
