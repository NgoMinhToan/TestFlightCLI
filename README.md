# MyTestflight CLI

CLI terminal và CI cho **[MyTestflightServer](https://github.com/NgoMinhToan/MyTestflightServer)** —
máy chủ catalog APK Android tự host. Đẩy APK theo từng kiến trúc (ABI) hoặc bản universal, xem ứng
dụng/phiên bản và tải bản phát hành mà không cần viết curl hay mở dashboard.

> **In English:** a terminal and CI client for MyTestflightServer — publish Android APKs per ABI or
> universal, inspect apps and versions, verify checksums and download builds. Node 22+.

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

`sha256` trong output được rút gọn còn 12 ký tự; bản đầy đủ có trong `--json` và `versions get`.

## Vì sao chọn CLI này (Why)

- **Cùng một API với dashboard và app Android.** Mọi thứ đẩy bằng CLI hiện ngay trong catalog của
  app và dashboard; không có định dạng dữ liệu riêng.
- **Một lệnh thay cho chuỗi curl.** `release` tạo version, tự nhận ABI từ `lib/<abi>/` (hoặc tên
  file), upload từng artifact và đối chiếu SHA-256 do server trả về. Không có dependency npm
  runtime; chỉ cần Node 22+.
- **Không ghi đè âm thầm.** Bản đã publish chỉ bị thay khi có `--force`/`--yes`, hoặc khi bạn xác
  nhận trong terminal. `--dry-run` in kế hoạch trước khi gửi.
- **Sẵn cho CI.** `--json`, exit code `0` thành công / `1` lỗi server hoặc mạng / `2` sai cú pháp /
  `130` bị huỷ; cấu hình qua `TESTFLIGHT_BASE_URL` và `TESTFLIGHT_MANAGEMENT_KEY`, không cần bước
  login.

**Khi nào nên dùng thứ khác:** cần Google Play internal testing, kiểm duyệt và phân phối qua hạ
tầng Google → dùng Play Console; muốn phân phối APK cho tester không tự host → dùng Firebase App
Distribution; chỉ upload một lần bằng `curl` → gọi thẳng
[write API](https://github.com/NgoMinhToan/MyTestflightServer#write-api); cần quản lý trực quan →
dùng [dashboard](https://github.com/NgoMinhToan/MyTestflightDashboard). CLI này chỉ nói chuyện với
MyTestflightServer tự host và không thay thế dịch vụ phân phối của Google.

## Cài đặt (Install)

Yêu cầu **Node.js 22+** trên macOS, Linux hoặc Windows, và một MyTestflightServer truy cập được
qua http(s). Management key nằm trong `data/config.json` của server; từ thư mục chứa `data/`, đọc
bằng `node -p 'require("./data/config.json").management_key'`, hoặc
`docker compose exec -T server cat /data/config.json`.

```bash
npm install -g my-testflight-cli
testflight --version
# 0.2.0
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

## Dùng thử nhanh với npx (Quick start)

```bash
# 1. Lưu base URL và management key; CLI kiểm tra trước khi lưu
npx my-testflight-cli@latest login http://127.0.0.1:8080

# 2. Đọc metadata APK hoàn toàn offline
npx my-testflight-cli@latest apk inspect app-arm64-v8a-release.apk --json

# 3. Một lệnh: server tự đọc APK, suy ABI, tạo app/version nếu cần
npx my-testflight-cli@latest publish app-arm64-v8a-release.apk --create

# 4. Hoặc chỉ định app/version như route cũ
npx my-testflight-cli@latest release crm app-arm64-v8a.apk --version 1.4.2 --version-code 142

# 5. Tải lại bản đã publish
npx my-testflight-cli@latest download crm 1.4.2 --out ./builds
```

`publish` dùng `POST /api/v1/import` (cần server mới; `release` vẫn chạy với server cũ). Nếu
`versionName` trong manifest là resource reference, `publish` bỏ query `version` để server tự
resolve; `release` dùng `String(versionCode)`.

## Cấu hình (Configuration)

`login` lưu base URL + key vào profile trong `~/.config/testflight/config.json` (Windows:
`%APPDATA%\testflight\config.json`; quyền `0600` trên macOS/Linux). Nhiều môi trường dùng
`--profile`:

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

Chi tiết về profile, kiểm tra key và bảo mật:
[Cấu hình](https://github.com/NgoMinhToan/TestFlightCLI/blob/main/docs/configuration.md).

## Các lệnh thường dùng (Usage)

```bash
# Version name/code lấy thẳng từ AndroidManifest.xml của APK
testflight release crm app-arm64-v8a.apk

# Split APK theo kiến trúc
testflight push crm app-arm64-v8a.apk app-x86_64.apk \
  --version 1.4.2 --version-code 142 --abi arm64-v8a --abi x86_64

# APK-only: server tự suy ABI, tạo app nếu chưa có
testflight publish app-arm64-v8a.apk --create

# Kiểm tra metadata offline
testflight apk inspect app-arm64-v8a.apk --json

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

## Version name, ABI và ghi đè (How)

- **Version name linh hoạt như Play Console:** 1–200 byte UTF-8, cho phép space, `+`, `()`, `[]`
  và Unicode (`1.0.0+42`, `Bản nội bộ (beta)`). Từ chối `/`, `\`, ký tự điều khiển, `.`/`..`, và
  space/dot ở đầu hoặc cuối. Tên được URL-encode khi gọi API, nên vẫn an toàn làm một path segment.
- **ABI** được chọn theo thứ tự: `--abi` → `AndroidManifest.xml` + native library
  (`lib/<abi>/`: đúng một ABI thì dùng, không hoặc nhiều ABI thì `universal`) → chuỗi ABI trong tên
  file, chỉ khi manifest không đọc được (ví dụ ZIP64). ABI hỗ trợ: `universal`, `arm64-v8a`,
  `armeabi-v7a`, `x86_64`, `x86`, `riscv64`, `armeabi`.
- **Version name/code** lấy từ `--version`/`--version-code`; thiếu thì đọc từ APK đầu tiên. Nếu
  manifest dùng resource reference cho `versionName`, `release` dùng `String(versionCode)`, còn
  `publish` để server resolve. Mọi APK trong một lần `release`/`publish` phải cùng package và
  version.
- Version mới được tạo dạng **draft**; nó chỉ xuất hiện trong catalog công khai sau APK đầu tiên.
- Draft nhận thêm ABI mà không cần `--force`. Version đã publish **có artifact cùng ABI**, hoặc
  metadata thay đổi, cần `--force`/`--yes` hay xác nhận trong terminal.
- `universal` luôn là artifact mặc định khi tải mà không chỉ định `--abi`; mỗi ABI tối đa một APK.
- Chạy lại sau lỗi giữa chừng với `--force` sẽ hoàn tất và thay các artifact đã upload bằng cùng
  nội dung. `--allow-mismatch package` vẫn là escape hatch cho API/CLI khi bạn chủ ý đổi package.

## Trạng thái (Status)

Phiên bản hiện tại **0.2.0** (2026-11-27). Đây là bản phát hành sớm: lệnh và cờ có thể thay đổi
trước `1.0`. CLI 0.2.x nhắm tới API `/api/v1` hiện hành của MyTestflightServer. Bản 0.2.0 thêm
version name linh hoạt, sửa lỗi upload stream đọc mất body lỗi của server (khiến CI báo
`http_422` thay vì `apk_metadata_mismatch`), và bổ sung quick command `npx`. CI chạy typecheck,
test và build trên Node 22 và 24; các bản npm được publish kèm provenance. Theo dõi
[Releases](https://github.com/NgoMinhToan/TestFlightCLI/releases).

## Tài liệu và dự án liên quan (Docs)

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

## Giấy phép (License)

MIT — xem [LICENSE](https://github.com/NgoMinhToan/TestFlightCLI/blob/main/LICENSE). CLI cần một
MyTestflightServer; server, app Android và dashboard là repo riêng, hiện chỉ CLI có file `LICENSE`.
Không liên kết với Apple; TestFlight là nhãn hiệu của Apple Inc.
