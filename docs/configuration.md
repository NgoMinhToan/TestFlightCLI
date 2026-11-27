# Cấu hình

CLI cần hai giá trị: **base URL** của MyTestflightServer và **management key**. Chúng có thể đến từ
flag, biến môi trường hoặc profile đã lưu.

Không cài toàn cục: thay `testflight` bằng `npx my-testflight-cli@latest`, ví dụ
`npx my-testflight-cli@latest login --url https://apps.example.com --key "$KEY"`.

## Kiểm tra key

`testflight login` mặc định kiểm tra trước khi lưu:

1. `GET /api/v1/health` — server có sống không.
2. `PUT /api/v1/apps/__testflight_cli_probe__` với body `{}`.

Server xác thực `X-Management-Key` **trước** khi kiểm tra id/body. Vì vậy:

| Kết quả | Nghĩa |
|---|---|
| `400 invalid_request` | Key **hợp lệ** (request không tạo dữ liệu nào) |
| `401 invalid_management_key` | Key sai |
| `503 management_key_not_configured` | Server chưa có `data/config.json` |

Đây cũng là cách dashboard kiểm tra token. Bỏ qua bằng `--no-verify` nếu server chưa sẵn sàng.

## Base URL

Base URL phải là `http(s)` origin, có thể kèm path prefix:

```text
http://127.0.0.1:8080
https://apps.example.com
https://example.com/testflight
```

Không chấp nhận credentials, query string hoặc fragment. CLI nối `/api/v1/...` vào sau base URL, nên
nếu server nằm sau reverse proxy có tiền tố, hãy nhập đúng tiền tố đó.

## File cấu hình

| Nền tảng | Đường dẫn mặc định |
|---|---|
| Linux/macOS | `$XDG_CONFIG_HOME/testflight/config.json` hoặc `~/.config/testflight/config.json` |
| Windows | `%APPDATA%\testflight\config.json` |

Đổi bằng `TESTFLIGHT_CONFIG=/absolute/path/config.json`.

```json
{
  "version": 1,
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "baseUrl": "http://127.0.0.1:8080",
      "managementKey": "…",
      "createdAt": "2026-11-26T08:00:00.000Z",
      "updatedAt": "2026-11-26T08:00:00.000Z"
    }
  }
}
```

- File được ghi atomic với quyền `0600`; thư mục `0700`.
- `testflight doctor` báo lỗi nếu file cho phép group/other đọc.
- Key nằm dạng plaintext trong file này (và trong `data/config.json` của server). Đối xử với nó như
  mật khẩu quản trị.

## Profile

```bash
testflight login --profile staging --url https://staging.example.com --key "$STAGING_KEY"
testflight login --profile prod    --url https://apps.example.com    --key "$PROD_KEY"

testflight config                 # liệt kê, key được che
testflight config use staging     # đổi profile mặc định
testflight apps --profile prod    # dùng profile khác cho một lệnh
testflight logout --profile staging
testflight logout --all
```

`TESTFLIGHT_PROFILE` đặt profile mặc định cho phiên shell.

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `TESTFLIGHT_BASE_URL` | Ghi đè base URL của profile |
| `TESTFLIGHT_MANAGEMENT_KEY` | Ghi đè management key |
| `TESTFLIGHT_PROFILE` | Profile mặc định cho lệnh |
| `TESTFLIGHT_CONFIG` | Đường dẫn file cấu hình |
| `NO_COLOR` | Tắt màu (chuẩn NO_COLOR) |

Thứ tự ưu tiên cho URL/key: **flag** (`--base-url`, `--key`) → **biến môi trường** → **profile**.

CLI tự đọc `.env` ở thư mục hiện tại nếu có; biến môi trường thật luôn thắng. Mẫu:
[`.env.example`](../.env.example).

### CI không cần login

```bash
TESTFLIGHT_BASE_URL=https://apps.example.com \
TESTFLIGHT_MANAGEMENT_KEY="$TESTFLIGHT_KEY" \
npx my-testflight-cli@latest release crm app.apk --version 1.4.2 --version-code 142
```

`testflight doctor` sẽ kiểm tra kết nối và key mà không cần file cấu hình khi cả hai biến đã có.
Version name không ảnh hưởng cấu hình; xem
[quy tắc version name](./commands.md#quy-tắc-version-name).

## Bảo mật

- Management key là **toàn quyền ghi** với server: tạo/xoá app, version, APK, icon.
- CLI chỉ gửi key cho request ghi; catalog, version và download là public theo thiết kế server.
- Trong CI, lấy key từ secret và truyền qua `TESTFLIGHT_MANAGEMENT_KEY`; không commit `.env`.
- Server lưu key plaintext trong `data/config.json`. Dùng mạng tin cậy hoặc đặt TLS (reverse proxy,
  Cloudflare Tunnel) trước server khi truy cập từ ngoài.
- CORS chỉ dành cho dashboard chạy trong trình duyệt; CLI không bị ảnh hưởng bởi CORS.
