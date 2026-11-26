# Lệnh và cờ

Tham chiếu đầy đủ cho `testflight` (alias `tf`). [README](../README.md) chỉ trình bày các luồng
thường dùng; trang này liệt kê mọi lệnh, cờ và quy tắc ghi.

Xem thêm: [Cấu hình](./configuration.md) · [CI, phát triển, xử lý sự cố](./operations.md).

## Global option

Mọi lệnh đều nhận:

| Option | Tác dụng |
|---|---|
| `--json` | Chỉ in JSON ra stdout; tắt log và thanh tiến trình |
| `-p, --profile <name>` | Dùng profile đã lưu thay cho profile mặc định |
| `--base-url <url>` | Ghi đè server URL cho riêng lệnh này |
| `--key <key>` | Ghi đè management key cho riêng lệnh này |
| `--verbose` | In thêm chi tiết, gồm stack trace khi có lỗi bất ngờ |
| `--no-color` | Tắt ANSI (ngoài ra tôn trọng `NO_COLOR`) |
| `-h, --help` | Trợ giúp của lệnh |

Thứ tự ưu tiên cho URL/key: **flag** → **biến môi trường** → **profile**. Chi tiết ở
[Cấu hình](./configuration.md).

## Thiết lập

### `login`

```text
testflight login [url] [options]
```

| Option | Tác dụng |
|---|---|
| `-u, --url <url>` | Base URL của server; có thể kèm path prefix |
| `-k, --key <key>` | Management key |
| `--key-stdin` | Đọc key từ stdin (dùng trong CI) |
| `--no-verify` | Lưu mà không gọi server |
| `-p, --profile <name>` | Profile cần tạo/cập nhật |

Không truyền URL hoặc key và đang ở terminal → CLI hỏi; key được ẩn khi nhập. Mặc định CLI kiểm tra
`GET /api/v1/health` và gửi một request ghi vô hại để xác thực key (xem
[Cấu hình](./configuration.md#kiểm-tra-key)). `--no-verify` bỏ qua bước kiểm tra.

```bash
testflight login http://127.0.0.1:8080
testflight login --url https://apps.example.com --key "$KEY"
printf '%s' "$KEY" | testflight login --url https://apps.example.com --key-stdin
```

### `logout`

```text
testflight logout [--profile <name>] [--all]
```

Xoá một profile, hoặc `--all` để xoá toàn bộ file cấu hình.

### `whoami`

In profile đang dùng, base URL, key đã che và nguồn cấu hình (flag, biến môi trường hay profile).

### `config`

```text
testflight config            # danh sách profile + đường dẫn file
testflight config path       # chỉ in đường dẫn
testflight config use <name> # đổi profile mặc định
```

### `doctor`

Kiểm tra Node ≥ 22, sự tồn tại và quyền của file cấu hình, kết nối server và management key.
Exit code `1` nếu bất kỳ mục nào lỗi, nên dùng được như bước kiểm tra trong CI. Với `--json`, kết
quả có dạng `{ "ok": boolean, "checks": [...] }`.

## Ứng dụng

### `apps` / `apps list`

```text
testflight apps [list] [--search <text>] [--sort name|id|latest]
testflight apps <appId>
```

- Không có positional → liệt kê ứng dụng.
- Một positional → hiển thị chi tiết ứng dụng đó (tương đương `apps get`).
- `--search` lọc không phân biệt hoa thường theo id, tên, package và developer.
- `--sort` mặc định `name`; `latest` xếp theo `versionCode` của bản mới nhất.

### `apps get`

```text
testflight apps get <appId>
```

Hiển thị metadata và các phiên bản **đã publish** (bản nháp không có trong catalog công khai).

### `apps create`

```text
testflight apps create <appId> [--name <text>] [--package <name>]
                            [--description <text>] [--developer <text>] [--icon <file>]
```

`appId` phải khớp `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Không có `--name` thì server tạo tên từ id
(`demo-app` → `Demo App`). `--icon` nhận PNG/JPEG/WebP ≤ 2 MiB và upload ngay sau khi tạo.

```bash
testflight apps create crm --name "Internal CRM" --package com.company.crm --icon ./icon.png
```

### `apps update`

```text
testflight apps update <appId> [--name] [--package] [--description] [--developer]
```

Chỉ gửi các trường được truyền; cần ít nhất một trường. Chuỗi rỗng (`--description ""`) xoá nội
dung.

### `apps delete`

```text
testflight apps delete <appId> [--yes]
```

Xoá ứng dụng cùng toàn bộ version và APK. Không có TTY thì bắt buộc `--yes`.

### `apps icon`

```text
testflight apps icon <appId> --file <png|jpg|jpeg|webp>
testflight apps icon <appId> --delete
```

Tối đa 2 MiB, đúng một trong hai cờ `--file`/`--delete`.

## Phiên bản và artifact

### `versions` / `versions list`

```text
testflight versions [list] <appId> [--published]
testflight versions <appId> <versionName>
```

- Mặc định đọc admin endpoint nên **gồm cả bản nháp**.
- `--published` đọc catalog công khai và bỏ bản nháp.
- Hai positional → hiển thị chi tiết phiên bản (tương đương `versions get`).

### `versions get`

```text
testflight versions get <appId> <versionName>
```

Hiển thị `versionCode`, `minSdk`, release notes, trạng thái draft, toàn bộ artifact, checksum và
artifact mặc định.

### `versions abis`

```text
testflight versions abis <appId> <versionName>
```

Liệt kê các kiến trúc (ABI) trong phiên bản. `--json` trả về:

```json
{
  "appId": "crm",
  "versionName": "1.4.2",
  "abis": ["universal", "arm64-v8a"],
  "universal": true,
  "defaultAbi": "universal",
  "artifacts": [{ "abi": "universal", "sizeBytes": 44171264, "sha256": "…", "downloadPath": "…" }]
}
```

### `versions create`

```text
testflight versions create <appId> <versionName> --version-code <n>
                           [--min-sdk <n>] [--release-notes <text>]
                           [--notes-file <path>] [--published-at <iso>]
```

Tạo **bản nháp** không có APK. Bản nháp chỉ hiện trong catalog công khai sau khi có artifact đầu
tiên; `release` làm bước này tự động.

### `versions update`

```text
testflight versions update <appId> <versionName>
                           [--version-code <n>] [--min-sdk <n> | --clear-min-sdk]
                           [--release-notes <text> | --notes-file <path> | --clear-notes]
                           [--published-at <iso>]
```

Cần ít nhất một trường. `--clear-min-sdk` và `--clear-notes` gửi `null` để xoá giá trị.

### `versions delete`

```text
testflight versions delete <appId> <versionName> [--yes]
```

Xoá version cùng toàn bộ APK của nó.

### `artifacts list` / `artifacts delete`

```text
testflight artifacts list <appId> <versionName>
testflight artifacts delete <appId> <versionName> <abi> [--yes]
```

Xoá artifact cuối cùng đưa version trở lại trạng thái draft. Dùng `versions abis` nếu chỉ cần xem.

## Phát hành

```text
testflight release <appId> <apk...> --version <name> --version-code <n> [options]
alias: testflight push ...
```

| Option | Ý nghĩa |
|---|---|
| `--version <name>` | **Bắt buộc** — tên version, ví dụ `1.4.2` |
| `--version-code <n>` | **Bắt buộc** — số nguyên dương |
| `--abi <abi>` | Lặp lại được hoặc phân tách bằng dấu phẩy; một giá trị cho mỗi APK |
| `--universal` | Ép một APK duy nhất thành `universal` |
| `--min-sdk <n>` | `minSdk` |
| `--release-notes <text>` | Ghi chú phát hành |
| `--notes-file <path>` | Đọc ghi chú từ file UTF-8 (không dùng cùng `--release-notes`) |
| `--published-at <iso>` | Thời điểm publish; mặc định server tự đặt |
| `--create` | Tạo app nếu chưa tồn tại |
| `--name`, `--package`, `--description`, `--developer` | Metadata dùng khi `--create` |
| `-f, --force` | Ghi đè artifact đã có và cập nhật metadata |
| `-y, --yes` | Chấp nhận thay thế mà không hỏi (kể cả khi không có TTY) |
| `-n, --dry-run` | In kế hoạch rồi thoát; chỉ đọc, không cần management key |
| `--no-progress` | Ẩn thanh tiến trình upload |

Ví dụ:

```bash
# ABI tự nhận diện từ lib/<abi>/ hoặc tên file
testflight release crm app-arm64-v8a.apk --version 1.4.2 --version-code 142

# Split APK theo kiến trúc
testflight release crm app-arm64-v8a.apk app-x86_64.apk \
  --version 1.4.2 --version-code 142 --abi arm64-v8a --abi x86_64

# Tạo app mới trong cùng lệnh
testflight release new-app app.apk --version 1.0.0 --version-code 1 \
  --create --name "New App" --package com.company.newapp

# Xem trước
testflight release crm app.apk --version 1.4.3 --version-code 143 --dry-run

# Thay bản đã publish
testflight release crm app.apk --version 1.4.2 --version-code 142 --force
```

### Cách CLI chọn ABI

Với mỗi APK, theo thứ tự:

1. `--abi` được truyền → dùng đúng giá trị đó.
2. Đọc **ZIP central directory**, tìm native library trong `lib/<abi>/`:
   - đúng **một** ABI → dùng ABI đó;
   - **nhiều** ABI → `universal`;
   - **không** có native library → bước 3.
3. Tên file chứa token ABI (`app-arm64-v8a.apk`, `release_x86_64.apk`) → dùng token đó.
4. Không xác định được → `universal`.

ABI hợp lệ, theo thứ tự ưu tiên của server: `universal`, `arm64-v8a`, `armeabi-v7a`, `x86_64`,
`x86`, `riscv64`, `armeabi`. Mỗi version có tối đa một APK cho mỗi ABI; trùng ABI là lỗi và CLI
dừng trước khi upload. Artifact `universal` luôn là artifact mặc định.

### Quy tắc ghi đè

- Version **chưa tồn tại** → tạo mới rồi upload.
- Version **đang là draft** → thêm artifact, không cần `--force`.
- Version **đã publish** và có artifact cùng ABI, hoặc metadata khác → CLI hỏi nếu là terminal;
  không có TTY thì cần `--force` hoặc `--yes`. Không bao giờ ghi đè âm thầm.
- Re-run sau lỗi giữa chừng: thêm `--force`; các artifact đã upload được thay bằng cùng nội dung
  (idempotent).

### Kết quả `--json`

```json
{
  "appId": "crm",
  "app": { "id": "crm", "name": "Internal CRM" },
  "version": { "versionName": "1.4.2", "versionCode": 142, "draft": false },
  "createdApp": false,
  "createdVersion": true,
  "updatedVersion": false,
  "forced": false,
  "uploads": [{ "abi": "arm64-v8a", "sizeBytes": 0, "sha256": "…", "created": true }],
  "downloadUrl": "https://apps.example.com/api/v1/apps/crm/versions/1.4.2/download"
}
```

`--dry-run --json` trả về `dryRun`, `appExists`, `versionExists`, `needsForce`, metadata
differences và danh sách artifact sẽ upload.

## Tải APK

```text
testflight download <appId> <versionName> [--abi <abi>] [--out <path>] [--force]
```

| Option | Ý nghĩa |
|---|---|
| `--abi <abi>` | Tải đúng artifact này thay vì artifact mặc định |
| `-o, --out <path>` | File, hoặc thư mục **đã tồn tại**; mặc định `./<appId>-<version>[-<abi>].apk` |
| `-f, --force` | Ghi đè file đã tồn tại |
| `--no-progress` | Ẩn thanh tiến trình |

Đọc là public, không cần management key. Nếu server trả `X-Checksum-Sha256`, CLI tính SHA-256 khi
tải và chỉ đổi tên file khi khớp; file hỏng bị xoá, file đích không bị thay.

```bash
testflight download crm 1.4.2
testflight download crm 1.4.2 --abi arm64-v8a --out ./builds
```

## Ánh xạ lệnh → API

| Lệnh CLI | Endpoint |
|---|---|
| `login` | `GET /api/v1/health`, `PUT /api/v1/apps/__testflight_cli_probe__` (vô hại) |
| `apps list`, `apps get` | `GET /api/v1/apps`, `GET /api/v1/apps/:appId` |
| `apps create/update/delete` | `POST /api/v1/apps`, `PUT`/`DELETE /api/v1/apps/:appId` |
| `apps icon` | `PUT`/`DELETE /api/v1/apps/:appId/icon` |
| `versions list`, `versions get/abis` | `GET /api/v1/apps/:appId/versions[/:version]` (admin, gồm draft) |
| `versions create/update/delete` | `POST`, `PUT`, `DELETE /api/v1/apps/:appId/versions[/:version]` |
| `release` | `GET` kiểm tra → `POST /versions` → `PUT .../artifacts/:abi` (hoặc `PUT /versions/:v`) |
| `download` | `GET /api/v1/apps/:appId/versions/:version/download[?abi=]` |
| `artifacts delete` | `DELETE .../artifacts/:abi` |

Mã lỗi server được giữ nguyên trong thông báo, ví dụ `HTTP 409 version_exists` hoặc `HTTP 401
invalid_management_key`; CLI thêm gợi ý xử lý. Xem bảng lỗi ở
[CI và xử lý sự cố](./operations.md#xử-lý-sự-cố).
