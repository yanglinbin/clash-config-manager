# 证书目录

把你自己申请的 SSL 证书放在这里（该目录内容不会提交到 Git）。

需要两个文件：

| 文件 | 说明 |
|------|------|
| `fullchain.pem` | 证书（**含中间证书链**；阿里云下载的 `.pem` 通常就是这个） |
| `privkey.pem`   | 私钥（阿里云下载的 `.key`） |

示例：

```bash
# 从阿里云下载的文件通常类似
#   1234567_clash.yilabao.top.pem
#   1234567_clash.yilabao.top.key
cp 1234567_clash.yilabao.top.pem nginx/certs/fullchain.pem
cp 1234567_clash.yilabao.top.key nginx/certs/privkey.pem

# 让 nginx 重新读取
docker compose up -d --force-recreate nginx
```

> 文件名可以不同 —— 只要同步修改 `nginx/default.conf` 里的
> `ssl_certificate` / `ssl_certificate_key` 路径即可。
>
> ⚠️ `privkey.pem` 是私钥，**不要提交到仓库**（已在 `.gitignore` 中忽略）。
