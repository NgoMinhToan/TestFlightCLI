# MyTestflight CLI

Client terminal và CI cho **[MyTestflightServer](https://github.com/NgoMinhToan/MyTestflightServer)**
— máy chủ catalog APK Android tự host. Đẩy APK theo từng kiến trúc (ABI) hoặc bản universal, xem
ứng dụng/phiên bản và tải bản phát hành mà không cần viết curl hay mở dashboard.

[![npm version](https://img.shields.io/npm/v/my-testflight-cli?label=npm)](https://www.npmjs.com/package/my-testflight-cli)
[![Node](https://img.shields.io/node/v/my-testflight-cli?label=node)](https://www.npmjs.com/package/my-testflight-cli)
[![CI](https://github.com/NgoMinhToan/TestFlightCLI/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NgoMinhToan/TestFlightCLI/actions/workflows/ci.yml)

```console
$ testflight release crm app-arm64-v8a.apk --version 1.4.2 --version-code 142
✓ Created version 1.4.2 (142).
Uploading app-arm64-v8a.apk → arm64-v8a (42.0 MB)
✓ Uploaded arm64-v8a — 42.0 MB, sha256 5e049e50d94a

✓ Published crm 1.4.2 (142).
ABI           SIZE  SHA-256
─────────  ───────  ────────────
arm64-v8a  42.0 MB  5e049e50d94a
→ Download: http://127.0.0.1:8080/api/v1/apps/crm/versions/1.4.2/download
```

## Vì sao dùng CLI này

- **Cùng một API với dashboard và app Android.** Mọi thứ đẩy bằng CLI hiện ngay trong catalog của
  app và dashboard; không có định dạng dữ liệu riêng.
- **Một lệnh thay cho chuỗi curl.** `release` tạo version, tự nhận ABI từ `lib/<abi>/` (hoặc tên
  file), upload từng artifact và đối chiếu SHA-256 do server trả về. Không có runtime dependency,
  chỉ cần Node 22+.
- **Không ghi đè âm thầm.** Bản đã publish chỉ bị thay khi có `--force`/`--yes`, hoặc khi bạn xác
  nhận trong terminal. `--dry-run` in kế hoạch trước khi gửi.
- **Sẵn cho CI.** `--json`, exit code `0`/`1`/`2`/`130`, cấu hình qua `TESTFLIGHT_BASE_URL` và
  `TESTFLIGHT_MANAGEMENT_KEY`, không cần bước login.

**Khi nào nên dùng thứ khác:** cần quản lý trực quan, icon và metadata hàng loạt → dùng
[dashboard](https://github.com/NgoMinhToan/MyTestflightDashboard); chỉ upload một lần bằng `curl` →
gọi thẳng [write API](https://github.com/NgoMinhToan/MyTestflightServer#write-api); cần Google
Play hoặc Firebase App Distribution → CLI này chỉ nói chuyện với MyTestflightServer, không thay thế
dịch vụ phân phối của Google.

## Cài đặt

Yêu cầu **Node.js 22+** và một MyTestflightServer truy cập được qua http(s). Management key nằm
trong `data/config.json` của server; đọc bằng
`node -p 'require("./data/config.json").management_key'`, hoặc
`docker compose exec -T server cat /data/config.json`.

```bash
npm install -g my-testflight-cli
testflight --version
# 0.1.1
```

Không muốn cài toàn cục: `npx my-testflight-cli@latest --help`. Lệnh có alias ngắn `tf`.

Từ source:

```bash
git clone https://github.com/NgoMinhToan/TestFlightCLI.git
cd TestFlightCLI
npm ci
npm run build
npm link          # hoặc: node dist/cli.js <command>
```

## Bắt đầu

```bash
# 1. Lưu base URL và management key; CLI kiểm tra trước khi lưu
testflight login http://127.0.0.1:8080

# 2. Tạo ứng dụng
testflight apps create crm --name "Internal CRM" --package com.company.crm

# 3. Đẩy bản phát hành; ABI tự nhận từ APK
testflight release crm app-arm64-v8a.apk --version 1.4.2 --version-code 142
```

Sau đó kiểm tra và tải lại:

```bash
testflight versions abis crm 1.4.2
testflight download crm 1.4.2 --out ./builds
```

`testflight doctor` kiểm tra Node, file cấu hình, kết nối server và key chỉ trong một lệnh.

## Cấu hình

`login` lưu base URL + key vào profile trong `~/.config/testflight/config.json` (Windows:
`%APPDATA%\testflight\config.json`; quyền `0600`).
Nhiều môi trường dùng `--profile`:

```bash
testflight login --profile staging --url https://staging.example.com --key "$STAGING_KEY"
testflight config use staging
testflight apps --profile prod
```

Trong CI, bỏ qua `login`:

| Biến | Ý nghĩa |
|---|---|
| `TESTFLIGHT_BASE_URL` | Base URL của server |
| `TESTFLIGHT_MANAGEMENT_KEY` | Management key |
| `TESTFLIGHT_PROFILE` | Profile mặc định |
| `TESTFLIGHT_CONFIG` | Đường dẫn file cấu hình |

Thứ tự ưu tiên cho URL/key: **flag** → **biến môi trường** → **profile**. CLI tự đọc `.env` ở thư
mục hiện tại; biến môi trường thật luôn thắng.

```bash
TESTFLIGHT_BASE_URL=https://apps.example.com \
TESTFLIGHT_MANAGEMENT_KEY="$TESTFLIGHT_KEY" \
testflight release crm app.apk --version 1.4.2 --version-code 142
```

Chi tiết về profile, kiểm tra key và bảo mật: [Cấu hình](https://github.com/NgoMinhToan/TestFlightCLI/blob/main/docs/configuration.md).

## Các lệnh thường dùng

```bash
# Split APK theo kiến trúc
testflight push crm app-arm64-v8a.apk app-x86_64.apk \
  --version 1.4.2 --version-code 142 --abi arm64-v8a --abi x86_64

# Tạo app mới kèm icon trong một lần
testflight apps create newapp --name "New App" --icon ./icon.png

# Xem trước, không ghi gì lên server
testflight release crm app.apk --version 1.4.3 --version-code 143 --dry-run

# Thay bản đã publish cùng version
testflight release crm app.apk --version 1.4.2 --version-code 142 --force

# Máy đọc cho CI
testflight versions abis crm 1.4.2 --json
```

Danh sách đầy đủ mọi lệnh và cờ:
[Lệnh và cờ](https://github.com/NgoMinhToan/TestFlightCLI/blob/main/docs/commands.md).

## Release hoạt động thế nào

- **ABI** được chọn theo thứ tự: `--abi` → native library trong APK (`lib/<abi>/`) → token trong
  tên file → `universal`.
- Version mới được tạo dạng **draft**; nó chỉ xuất hiện trong catalog công khai sau APK đầu tiên.
- Draft nhận thêm ABI mà không cần `--force`. Version đã publish, hoặc metadata thay đổi, cần
  `--force`/`--yes` hay xác nhận trong terminal.
- `universal` luôn là artifact mặc định; mỗi ABI tối đa một APK.
- Chạy lại sau lỗi giữa chừng với `--force` sẽ hoàn tất và thay các artifact đã upload bằng cùng
  nội dung.

## Trạng thái

Phiên bản hiện tại **0.1.1** (2026-11-26). Đây là bản phát hành sớm: lệnh và cờ có thể thay
đổi trước `1.0`. CI chạy typecheck, test và build trên Node 22 và 24; các bản npm được publish kèm
provenance. Theo dõi [Releases](https://github.com/NgoMinhToan/TestFlightCLI/releases).

## Tài liệu và dự án liên quan

- [Lệnh và cờ](https://github.com/NgoMinhToan/TestFlightCLI/blob/main/docs/commands.md)
- [Cấu hình](https://github.com/NgoMinhToan/TestFlightCLI/blob/main/docs/configuration.md)
- [CI, phát triển và xử lý sự cố](https://github.com/NgoMinhToan/TestFlightCLI/blob/main/docs/operations.md)
- [MyTestflightServer](https://github.com/NgoMinhToan/MyTestflightServer) — API, volume và
  management key
- [MyAndroidTestflight](https://github.com/NgoMinhToan/MyAndroidTestflight) — app đọc catalog và
  cài APK
- [MyTestflightDashboard](https://github.com/NgoMinhToan/MyTestflightDashboard) — dashboard web
  dùng cùng API
- [GitHub Issues](https://github.com/NgoMinhToan/TestFlightCLI/issues) — báo lỗi và đề xuất

## Giấy phép

MIT — xem [LICENSE](https://github.com/NgoMinhToan/TestFlightCLI/blob/main/LICENSE).
