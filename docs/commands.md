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

## Kiểm tra APK

### `apk inspect`

```text
testflight apk inspect <apk...> [--json]
```

Đọc **ZIP central directory** và `AndroidManifest.xml` nhị phân (AXML) ngay trên máy — không cần
server hay management key. In `packageName`, `versionCode`, `versionName`, `minSdk`, `targetSdk`,
các ABI trong `lib/<abi>/`, `debuggable`, `testOnly`, `split` và `configSplit`.

```bash
testflight apk inspect app-arm64-v8a-release.apk
testflight apk inspect build/*.apk --json
```

`--json` trả về `{ "files": [...] }`; file đọc được có `path`, `fileName`, `sizeBytes`, `metadata`
và `artifactAbi`, file lỗi có `{ "path": ..., "error": ... }`. Nếu bất kỳ file nào lỗi, lệnh vẫn in
hết kết quả rồi thoát với exit code `1`.

Một file ZIP64, manifest thiếu/hỏng hoặc archive không phải APK không được đoán bừa: lệnh báo lỗi
và không đưa ra metadata giả.

## Phát hành

### `publish` — APK-only, server tự suy ABI

```text
testflight publish <apk...> [--app-id <id>] [--create] [options]
```

Dùng endpoint mới `POST /api/v1/import`: server tự đọc APK, suy ABI và tạo app/version nếu cần.

| Option | Ý nghĩa |
|---|---|
| `--app-id <id>` | Id ứng dụng; mặc định là `packageName` trong APK |
| `--create` | Tạo app nếu chưa tồn tại (mặc định trả 404) |
| `--name <text>` | Tên hiển thị dùng khi `--create` |
| `--version <name>` | Tên version; mặc định lấy từ APK |
| `--version-code <n>` | `versionCode`; mặc định lấy từ APK |
| `--release-notes <text>` | Ghi chú phát hành |
| `--notes-file <path>` | Đọc ghi chú từ file UTF-8 |
| `--published-at <iso>` | Thời điểm publish |
| `--allow-mismatch <csv>` | Bỏ kiểm tra chủ ý: `package,version,sdk,abi` |
| `-n, --dry-run` | Kiểm tra và in kế hoạch hoàn toàn offline |
| `--no-progress` | Ẩn thanh tiến trình |

CLI kiểm tra **toàn bộ** APK trước khi gửi: mọi file phải cùng `packageName`, `versionCode` và
`versionName` (bỏ qua `versionName` null), không trùng ABI, không phải config split. Nếu lệch, lệnh
dừng với exit code `2` và **không tạo gì** trên server.

Nếu bạn truyền `--version`/`--version-code` khác giá trị trong APK, CLI tự thêm
`allow_mismatch=version`; giá trị `--allow-mismatch` của bạn được hợp nhất vào đó. Ghi chú dài hơn
4 KiB không nhét vừa query string: CLI import trước, rồi gọi `PUT /versions/:v` để ghi ghi chú.
Import chạy tuần tự từng APK và dừng ở lỗi đầu tiên.

```bash
# App id và version lấy từ APK, tạo app nếu chưa có
testflight publish app-arm64-v8a-release.apk --create

# Ba split APK cùng một version
testflight publish build/app-arm64-v8a.apk build/app-armeabi-v7a.apk build/app-x86_64.apk \
  --app-id crm --json

# Xem trước, không cần server/key
testflight publish app.apk --dry-run --json
```

`--dry-run --json` trả về `dryRun`, `appId`, `create`, `versionName`, `versionCode`,
`versionNameSource`, `versionCodeSource`, `allowMismatch`, `files` và `imports: []`.

Server cũ không có `/import` trả 404; CLI thêm gợi ý nâng cấp server. `release` vẫn dùng các route
artifact cũ nên tiếp tục chạy với server cũ.

### `release`

```text
testflight release <appId> <apk...> [--version <name>] [--version-code <n>] [options]
alias: testflight push ...
```

| Option | Ý nghĩa |
|---|---|
| `--version <name>` | Tên version; mặc định lấy `versionName` từ APK đầu tiên |
| `--version-code <n>` | Số nguyên dương; mặc định lấy `versionCode` từ APK đầu tiên |
| `--abi <abi>` | Lặp lại được hoặc phân tách bằng dấu phẩy; một giá trị cho mỗi APK |
| `--universal` | Ép một APK duy nhất thành `universal` |
| `--min-sdk <n>` | `minSdk` |
| `--release-notes <text>` | Ghi chú phát hành |
| `--notes-file <path>` | Đọc ghi chú từ file UTF-8 (không dùng cùng `--release-notes`) |
| `--published-at <iso>` | Thời điểm publish; mặc định server tự đặt |
| `--allow-mismatch <csv>` | Bỏ kiểm tra chủ ý: `package`, `version`, `sdk`, `abi`; hợp nhất với các giá trị CLI tự thêm khi flag lệch APK |
| `--create` | Tạo app nếu chưa tồn tại |
| `--name`, `--package`, `--description`, `--developer` | Metadata dùng khi `--create` |
| `-f, --force` | Ghi đè artifact đã có và cập nhật metadata |
| `-y, --yes` | Chấp nhận thay thế mà không hỏi (kể cả khi không có TTY) |
| `-n, --dry-run` | In kế hoạch rồi thoát; chỉ đọc, không cần management key |
| `--no-progress` | Ẩn thanh tiến trình upload |

Ví dụ:

```bash
# Version name/code lấy từ AndroidManifest.xml của APK
testflight release crm app-arm64-v8a.apk

# Ghi đè version name/code (CLI tự gửi allow_mismatch=version nếu lệch APK)
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

1. `--abi` được truyền → dùng đúng giá trị đó (CLI thêm `allow_mismatch=abi` nếu khác APK).
2. Đọc `AndroidManifest.xml` và tìm native library trong `lib/<abi>/`:
   - đúng **một** ABI → dùng ABI đó;
   - **không** hoặc **nhiều** ABI → `universal`.
3. Chỉ khi **không đọc được manifest** (ví dụ ZIP64), mới đoán token ABI trong tên file
   (`app-arm64-v8a.apk`, `release_x86_64.apk`), rồi cuối cùng là `universal`. CLI in cảnh báo vì
   server có thể từ chối file đó.

Metadata trong APK là nguồn chân lý; tên file không được ghi đè manifest đọc được. Nếu bạn truyền
`--version`/`--version-code`/`--min-sdk` khác APK, CLI thêm đúng loại vào `allow_mismatch`
(`version`/`sdk`). Mọi APK trong một lần `release` phải cùng package và version.

`--allow-mismatch` dùng khi bạn **chủ ý** thay đổi một trường, ví dụ app đã đổi package hoặc version
đã publish với metadata khác APK. Giá trị được hợp nhất với các loại CLI tự suy ra và gửi cho mọi
artifact, theo thứ tự `package,version,sdk,abi`.

```bash
# App "crm" đã có package com.other nhưng APK mang package mới
testflight release crm app.apk --version 0.2.0 --version-code 18 \
  --force --allow-mismatch package
```

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
differences và danh sách artifact sẽ upload. Cả `--json` thật lẫn dry-run có thêm
`versionNameInferred`/`versionCodeInferred`, `detected`, `allowMismatch`; mỗi upload có `detected`
(metadata server đọc được từ APK).

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
| `release` | `GET` kiểm tra → `POST /versions` → `PUT .../artifacts/:abi[?allow_mismatch=]` (hoặc `PUT /versions/:v`) |
| `publish` | `POST /api/v1/import?…[&allow_mismatch=]`, sau đó `PUT /versions/:v` nếu notes > 4 KiB |
| `apk inspect` | Không gọi server |
| `download` | `GET /api/v1/apps/:appId/versions/:version/download[?abi=]` |
| `artifacts delete` | `DELETE .../artifacts/:abi` |

Mã lỗi server được giữ nguyên trong thông báo, ví dụ `HTTP 409 version_exists` hoặc `HTTP 401
invalid_management_key`; CLI thêm gợi ý xử lý. Xem bảng lỗi ở
[CI và xử lý sự cố](./operations.md#xử-lý-sự-cố).
