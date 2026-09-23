# 证书目录

把你自己申请的 SSL 证书放在这里（该目录内容不会提交到 Git）。

需要两个文件（文件名与 `nginx/default.conf` 中的路径一致）：

| 文件 | 说明 |
|------|------|
| `cert.crt` | 证书（**建议含中间证书链**；多数服务商下载的 `.crt` / `.pem` 已包含） |
| `cert.key` | 私钥 |

```bash
# 例如从服务商下载的文件名是 cert.crt / cert.key，直接放进来即可
cp cert.crt cert.key nginx/certs/

# 确认文件到位（宿主机侧）
ls -l nginx/certs/

# 让 nginx 重新读取
docker compose up -d --force-recreate nginx
```

> 文件名可以不同 —— 只要同步修改 `nginx/default.conf` 里的
> `ssl_certificate` / `ssl_certificate_key` 路径即可。
>
> ⚠️ `cert.key` 是私钥，**不要提交到仓库**（本目录内容已在 `.gitignore` 中忽略）。
